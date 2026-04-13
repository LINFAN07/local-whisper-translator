"""
JSONL 協議（每行一個 JSON）：
- {"type":"progress","value":0.0~1.0,"message":"..."}
- {"type":"segment","start":秒,"end":秒,"text":"..."}
- {"type":"error","message":"..."}
- {"type":"downloaded","path":"本機媒體絕對路徑","title":"可選，串流標題"}（僅在輸入為 http(s) 連結且下載成功後送出，供前端播放）
http(s) 輸入時由 yt-dlp 下載影片（優先合併為 mp4，失敗則 mkv，再退回單檔 best；支援多數常見影音站）。
YouTube 連結：桌面版會先偵測是否可取得字幕並讓使用者選擇「帶入字幕」或「Whisper 轉錄」；選擇帶入時下載字幕為逐字稿並略過 Whisper。
環境變數 WHISPER_MODEL 可覆寫模型名稱；未設定時 GPU 預設 large-v3，CPU 預設 medium（較適合無獨顯環境）。
WHISPER_DEVICE=auto 時以 CTranslate2（與 faster-whisper 相同後端）偵測 CUDA，無需安裝 PyTorch。
Windows GPU：需 cuBLAS／cuDNN（npm run setup:python 會安裝 requirements-cuda-windows.txt，或手動 pip）。
偵測語言為中文（zh／yue）時，轉錄文字會經 OpenCC 統一為台灣繁體（s2tw）。
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request


def _exit_zero_skip_interpreter_teardown() -> None:
    """Windows 上 faster-whisper／CTranslate2 等偶發在直譯器關閉時存取違規（exit 3221226505），導致前端誤判失敗。成功輸出後立即結束程序。"""
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except OSError:
        pass
    os._exit(0)


def emit(obj: dict) -> None:
    line = json.dumps(obj, ensure_ascii=False)
    print(line, flush=True)
    # 同步寫入 stderr，讓 Electron 在 stdout 緩衝異常時仍能從 stderr 轉發錯誤
    if obj.get("type") == "error":
        try:
            print(line, file=sys.stderr, flush=True)
        except OSError:
            pass


def _resolve_whisper_device(requested: str) -> str:
    """將 auto/cpu/cuda 解析為 faster-whisper 使用的 device。auto 依 CTranslate2 偵測 GPU。"""
    r = (requested or "auto").strip().lower()
    if r not in ("auto", "cpu", "cuda"):
        r = "auto"
    if r == "cuda":
        return "cuda"
    if r == "cpu":
        return "cpu"
    try:
        import ctranslate2 as ct2

        return "cuda" if ct2.get_cuda_device_count() > 0 else "cpu"
    except Exception:
        return "cpu"


def _site_packages_dirs() -> list[str]:
    roots: list[str] = []
    seen: set[str] = set()

    def add(p: str) -> None:
        if p and os.path.isdir(p) and p not in seen:
            seen.add(p)
            roots.append(p)

    try:
        import site

        for p in site.getsitepackages():
            add(p)
    except Exception:
        pass
    add(os.path.join(sys.prefix, "Lib", "site-packages"))
    bp = getattr(sys, "base_prefix", None)
    if bp and os.path.normcase(bp) != os.path.normcase(sys.prefix):
        add(os.path.join(bp, "Lib", "site-packages"))
    return roots


def _register_windows_cuda_runtime_paths() -> None:
    """將 pip 安裝的 nvidia-*-cu12 套件之 bin 加入 PATH 與 DLL 搜尋路徑（CTranslate2 以原生方式載入 cublas64_12.dll）。"""
    if sys.platform != "win32":
        return

    bin_dirs: list[str] = []
    seen: set[str] = set()
    rel_bins = (
        ("nvidia", "cublas", "bin"),
        ("nvidia", "cudnn", "bin"),
        ("nvidia", "cuda_runtime", "bin"),
        ("nvidia", "cuda_nvrtc", "bin"),
        ("nvidia", "cufft", "bin"),
        ("nvidia", "curand", "bin"),
        ("nvidia", "cusolver", "bin"),
        ("nvidia", "cusparse", "bin"),
    )

    for sp in _site_packages_dirs():
        for parts in rel_bins:
            d = os.path.join(sp, *parts)
            if not os.path.isdir(d):
                continue
            try:
                has_dll = any(
                    name.lower().endswith(".dll") for name in os.listdir(d)
                )
            except OSError:
                continue
            if has_dll and d not in seen:
                seen.add(d)
                bin_dirs.append(d)

        nvidia_root = os.path.join(sp, "nvidia")
        if not os.path.isdir(nvidia_root):
            continue
        for dirpath, _sub, filenames in os.walk(nvidia_root):
            if os.path.basename(dirpath).lower() != "bin":
                continue
            if not any(fn.lower().endswith(".dll") for fn in filenames):
                continue
            if dirpath not in seen:
                seen.add(dirpath)
                bin_dirs.append(dirpath)

    if not bin_dirs:
        return

    extra = ";".join(bin_dirs)
    os.environ["PATH"] = extra + ";" + os.environ.get("PATH", "")

    add_dll = getattr(os, "add_dll_directory", None)
    if add_dll:
        for d in bin_dirs:
            try:
                add_dll(d)
            except OSError:
                pass


def _windows_cuda_wheel_hint() -> str:
    return (
        "\n\n【Windows GPU】若缺少 cublas64_12.dll／cuDNN：在專案目錄執行 "
        "`npm run setup:python`，或手動："
        "`python -m pip install -r python_service/requirements-cuda-windows.txt`。"
        "亦可將「本機轉錄裝置」改為 CPU 暫時轉錄。"
    )


def _append_cuda_hint_if_dll_error(msg: str, err: BaseException) -> str:
    t = f"{type(err).__name__}: {err}".lower()
    if sys.platform != "win32":
        return msg
    if any(
        x in t
        for x in ("cublas", "cudnn", ".dll", "loadlibrary", "cannot be loaded")
    ):
        return msg + _windows_cuda_wheel_hint()
    return msg


def _is_http_url(s: str) -> bool:
    t = (s or "").strip()
    return t.startswith("http://") or t.startswith("https://")


def _whisper_lang_is_chinese(lang: str) -> bool:
    """faster-whisper 偵測碼：zh、zh-*、粵語 yue 皆以漢字為主，一併做繁體化。"""
    lo = (lang or "").strip().lower()
    return lo == "zh" or lo.startswith("zh-") or lo == "yue"


def _make_zh_traditional_converter():
    """簡體 → 台灣繁體（Whisper 中文輸出多為簡體）。若未安裝 opencc 則回傳 None。"""
    try:
        from opencc import OpenCC  # type: ignore[import-untyped]

        return OpenCC("s2tw")
    except ImportError:
        return None


def _extract_stream_title(url: str) -> str | None:
    """以 yt-dlp 取得串流標題（不下載），供介面顯示（例如 YouTube 影片名稱）。"""
    u = (url or "").strip()
    if not u:
        return None
    try:
        import yt_dlp  # type: ignore  # noqa: F401
    except ImportError:
        return None
    opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "socket_timeout": 40,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(u, download=False)
    except Exception:
        return None
    if not info:
        return None
    title = info.get("title") or info.get("fulltitle") or info.get("alt_title")
    if isinstance(title, str):
        t = title.strip()
        if t:
            return t
    return None


def _is_youtube_url(url: str) -> bool:
    lu = (url or "").strip().lower()
    return (
        "youtube.com" in lu
        or "youtu.be" in lu
        or "youtube-nocookie.com" in lu
    )


_TAG_STRIP_RE = re.compile(r"<[^>]+>")


def _clean_subtitle_text(s: str) -> str:
    t = _TAG_STRIP_RE.sub("", s or "")
    t = html.unescape(t)
    return " ".join(t.split()).strip()


def _vtt_timestamp_to_seconds(ts: str) -> float:
    ts = (ts or "").strip().replace(",", ".")
    parts = ts.split(":")
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    if len(parts) == 1:
        return float(parts[0])
    raise ValueError(ts)


def _parse_vtt_to_segments(vtt_text: str) -> list[tuple[float, float, str]]:
    text = vtt_text.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    segments: list[tuple[float, float, str]] = []
    i = 0
    n = len(lines)
    while i < n:
        raw = lines[i].strip()
        if "-->" in raw and not raw.upper().startswith("NOTE"):
            left, _, right = raw.partition("-->")
            left = left.strip()
            right = right.strip()
            right_time = right.split()[0] if right else ""
            if not left or not right_time:
                i += 1
                continue
            try:
                t0 = _vtt_timestamp_to_seconds(left)
                t1 = _vtt_timestamp_to_seconds(right_time)
            except (ValueError, IndexError):
                i += 1
                continue
            i += 1
            buf: list[str] = []
            while i < n:
                ln = lines[i]
                st = ln.strip()
                if st == "":
                    break
                if "-->" in st and not st.upper().startswith("NOTE"):
                    break
                buf.append(st)
                i += 1
            body = _clean_subtitle_text(" ".join(buf))
            if body:
                segments.append((t0, t1, body))
            continue
        i += 1
    return segments


def _parse_youtube_json3_to_segments(raw: str) -> list[tuple[float, float, str]]:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    events = data.get("events")
    if not isinstance(events, list):
        return []
    out: list[tuple[float, float, str]] = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        segs = ev.get("segs")
        if not isinstance(segs, list):
            continue
        parts: list[str] = []
        for s in segs:
            if isinstance(s, dict):
                u = s.get("utf8")
                if isinstance(u, str):
                    parts.append(u)
        text = _clean_subtitle_text("".join(parts))
        if not text:
            continue
        start = float(ev.get("tStartMs", 0) or 0) / 1000.0
        dur_ms = ev.get("dDurationMs")
        if dur_ms is None:
            end = start + 2.0
        else:
            end = start + max(0.05, float(dur_ms) / 1000.0)
        out.append((start, end, text))
    return out


# 優先繁中 → 簡中 → 英文等（YouTube 語言碼依影片而異，未命中時會改採任一手動字幕再任自動字幕）
_YT_SUB_LANG_PRIORITY: tuple[str, ...] = (
    "zh-Hant",
    "zh-TW",
    "zh-HK",
    "zh-Hans",
    "zh-CN",
    "zh",
    "cht",
    "cmn-Hant",
    "cmn-Hans",
    "cmn",
    "yue",
    "en",
    "en-US",
    "en-GB",
    "ja",
    "ko",
)


def _pick_youtube_subtitle_url(
    entries: list | None,
) -> tuple[str, str] | None:
    """僅選可解析的 vtt／json3。回傳 (url, ext)。"""
    if not entries:
        return None
    for e in entries:
        if not isinstance(e, dict) or not e.get("url"):
            continue
        ext = (e.get("ext") or "").lower()
        if ext in ("vtt", "webvtt", "json3"):
            return (str(e["url"]), ext)
    return None


def _subtitle_lang_should_traditionalize(lang_code: str) -> bool:
    lo = (lang_code or "").strip().lower().replace("_", "-")
    if _whisper_lang_is_chinese(lo):
        return True
    if lo in ("cht", "cmn", "yue") or lo.startswith("cmn-"):
        return True
    return False


def _yt_dlp_extract_info_for_subtitles(url: str) -> dict | None:
    """不下載影片，僅取得可供字幕挑選的 info。"""
    if not _is_youtube_url(url):
        return None
    try:
        import yt_dlp  # type: ignore  # noqa: F401
    except ImportError:
        return None
    info_opts: dict = {
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 40,
        "extractor_args": {"youtube": {"player_client": ["android", "web"]}},
    }
    try:
        with yt_dlp.YoutubeDL(info_opts) as ydl:
            info = ydl.extract_info(url.strip(), download=False)
    except Exception:
        return None
    if not info or not isinstance(info, dict):
        return None
    return info


def _pick_youtube_subtitle_track_from_info(
    info: dict,
) -> tuple[str, str, str, str] | None:
    """
    從 extract_info 結果挑選一組可解析的 vtt／json3 字幕。
    回傳 (sub_url, sub_ext, chosen_lang, source)，source 為 manual 或 auto。
    """
    manual = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}
    if not isinstance(manual, dict):
        manual = {}
    if not isinstance(auto, dict):
        auto = {}

    chosen_lang = ""
    sub_url = ""
    sub_ext = ""
    source = ""

    for lang in _YT_SUB_LANG_PRIORITY:
        if lang in manual:
            picked = _pick_youtube_subtitle_url(manual.get(lang))
            if picked:
                sub_url, sub_ext = picked
                chosen_lang = lang
                source = "manual"
                break
        if lang in auto:
            picked = _pick_youtube_subtitle_url(auto.get(lang))
            if picked:
                sub_url, sub_ext = picked
                chosen_lang = lang
                source = "auto"
                break

    if not sub_url:
        for lang, entries in manual.items():
            picked = _pick_youtube_subtitle_url(
                entries if isinstance(entries, list) else None
            )
            if picked:
                sub_url, sub_ext = picked
                chosen_lang = str(lang)
                source = "manual"
                break

    if not sub_url:
        for lang, entries in auto.items():
            picked = _pick_youtube_subtitle_url(
                entries if isinstance(entries, list) else None
            )
            if picked:
                sub_url, sub_ext = picked
                chosen_lang = str(lang)
                source = "auto"
                break

    if not sub_url:
        return None
    return (sub_url, sub_ext, chosen_lang, source)


def _probe_youtube_subtitles_result(url: str) -> dict:
    """供 --probe-youtube-subs 輸出一行 JSON；不載入字幕內文。"""
    if not _is_youtube_url(url):
        return {"ok": True, "available": False}
    try:
        import yt_dlp  # type: ignore  # noqa: F401
    except ImportError:
        return {
            "ok": False,
            "available": False,
            "error": "未安裝 yt-dlp，無法檢查字幕。",
        }
    info = _yt_dlp_extract_info_for_subtitles(url)
    if info is None:
        return {
            "ok": False,
            "available": False,
            "error": "無法取得影片資訊（網路、連結或 yt-dlp 版本）。",
        }
    picked = _pick_youtube_subtitle_track_from_info(info)
    if not picked:
        return {"ok": True, "available": False}
    _sub_url, _ext, lang, source = picked
    src_label = "上傳字幕" if source == "manual" else "自動字幕"
    label = f"{src_label} · {lang or '?'}"
    return {
        "ok": True,
        "available": True,
        "label": label,
        "lang": lang,
        "source": source,
    }


def _try_fetch_youtube_subtitle_segments(
    url: str,
) -> tuple[list[tuple[float, float, str]], str, str]:
    """
    嘗試取得 YouTube 字幕並轉成 (start,end,text) 列表。
    回傳 (segments, 顯示用說明, 語言碼)；無可用字幕時 segments 為空列表。
    """
    if not _is_youtube_url(url):
        return [], "", ""

    info = _yt_dlp_extract_info_for_subtitles(url)
    if not info:
        return [], "", ""

    picked = _pick_youtube_subtitle_track_from_info(info)
    if not picked:
        return [], "", ""

    sub_url, sub_ext, chosen_lang, source = picked

    try:
        req = urllib.request.Request(
            sub_url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                ),
            },
        )
        with urllib.request.urlopen(req, timeout=90) as resp:
            raw_bytes = resp.read()
        raw = raw_bytes.decode("utf-8", errors="replace")
    except (urllib.error.URLError, OSError, ValueError):
        return [], "", ""

    if sub_ext == "json3":
        cues = _parse_youtube_json3_to_segments(raw)
    else:
        cues = _parse_vtt_to_segments(raw)

    if not cues:
        return [], "", ""

    src_label = "上傳字幕" if source == "manual" else "自動字幕"
    display = f"{src_label} · {chosen_lang or '?'}"

    return cues, display, chosen_lang


_VIDEO_EXTENSIONS = frozenset(
    {
        ".mp4",
        ".mkv",
        ".webm",
        ".mov",
        ".avi",
        ".m4v",
        ".mpeg",
        ".mpg",
        ".flv",
        ".wmv",
    }
)


def _ffmpeg_executable() -> str | None:
    """系統 PATH → imageio-ffmpeg 內建二進位（無須另行安裝 ffmpeg）。"""
    env = (
        os.environ.get("FFMPEG_PATH")
        or os.environ.get("VOICE_TRANSLATOR_FFMPEG")
        or ""
    ).strip()
    if env:
        return env
    w = shutil.which("ffmpeg")
    if w:
        return w
    try:
        import imageio_ffmpeg  # type: ignore

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.isfile(exe):
            return exe
    except Exception:
        pass
    return None


def _ffprobe_executable() -> str | None:
    ffmpeg = _ffmpeg_executable()
    if ffmpeg:
        base = os.path.dirname(ffmpeg)
        for name in ("ffprobe", "ffprobe.exe"):
            p = os.path.join(base, name)
            if os.path.isfile(p):
                return p
    return shutil.which("ffprobe")


def _wav_duration_seconds(path: str) -> float | None:
    try:
        import wave

        with wave.open(path, "rb") as wf:
            frames = wf.getnframes()
            rate = wf.getframerate()
            if rate <= 0:
                return None
            d = frames / float(rate)
            return d if d > 0 else None
    except Exception:
        return None


def _probe_media_duration_seconds(path: str) -> float | None:
    """以 ffprobe（或 WAV 標頭）取得音訊／影片長度（秒）。"""
    if not path or not os.path.isfile(path):
        return None
    probe = _ffprobe_executable()
    if probe:
        cmd = [
            probe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ]
        try:
            r = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
            )
            if r.returncode == 0 and (r.stdout or "").strip():
                sec = float((r.stdout or "").strip().split()[0])
                if sec > 0:
                    return sec
        except (ValueError, subprocess.TimeoutExpired, OSError):
            pass
    if path.lower().endswith(".wav"):
        return _wav_duration_seconds(path)
    return None


def _format_mmss(seconds: float) -> str:
    if seconds < 0:
        seconds = 0.0
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"{m}:{s:02d}"


def _should_extract_audio_before_transcribe(path: str) -> bool:
    """影片容器先經 ffmpeg 抽音訊，避免 faster-whisper／PyAV 解析部分 MP4/MKV 時 IndexError。"""
    lower = path.lower()
    i = lower.rfind(".")
    if i < 0:
        return True
    return lower[i:] in _VIDEO_EXTENSIONS


def _extract_audio_wav_for_whisper(input_path: str) -> tuple[str | None, str | None]:
    """抽出 16kHz mono PCM WAV，供 Whisper 讀取。"""
    ffmpeg = _ffmpeg_executable()
    if not ffmpeg:
        return None, (
            "找不到 ffmpeg。請在「本程式使用的」Python 環境執行：\n"
            "  python -m pip install -r python_service/requirements.txt\n"
            "（內含 imageio-ffmpeg，可自動提供 ffmpeg）\n"
            "或自行安裝 ffmpeg 並加入 PATH，或設定 FFMPEG_PATH／VOICE_TRANSLATOR_FFMPEG。"
        )
    fd, out_wav = tempfile.mkstemp(suffix=".wav", prefix="voice_translator_aw_")
    os.close(fd)
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        input_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        out_wav,
    ]
    r = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env={**os.environ},
    )
    if r.returncode != 0:
        try:
            os.unlink(out_wav)
        except OSError:
            pass
        err = (r.stderr or r.stdout or "").strip()
        if len(err) > 800:
            err = err[:800] + "…"
        return None, f"ffmpeg 抽取音訊失敗：{err or '未知錯誤'}"

    try:
        if not os.path.isfile(out_wav) or os.path.getsize(out_wav) < 64:
            try:
                os.unlink(out_wav)
            except OSError:
                pass
            return None, "ffmpeg 輸出之 WAV 異常（檔案過小或不存在）。"
    except OSError:
        try:
            os.unlink(out_wav)
        except OSError:
            pass
        return None, "無法讀取 ffmpeg 輸出檔。"

    return out_wav, None


def _pick_largest_media_file(tmpdir: str) -> str | None:
    """選擇暫存目錄內最大的非 .part 檔案（yt-dlp 合併後通常僅一個輸出檔）。"""
    candidates: list[tuple[int, str]] = []
    try:
        for name in os.listdir(tmpdir):
            if name.endswith(".part"):
                continue
            p = os.path.join(tmpdir, name)
            if os.path.isfile(p):
                try:
                    candidates.append((os.path.getsize(p), p))
                except OSError:
                    continue
    except OSError:
        return None
    if not candidates:
        return None
    candidates.sort(key=lambda x: x[0], reverse=True)
    try:
        return os.path.abspath(candidates[0][1])
    except OSError:
        return candidates[0][1]


def _download_media_from_url(url: str) -> tuple[str | None, str | None]:
    """以 yt-dlp 下載影片至暫存目錄（優先合併影音為 mp4，失敗則 mkv，再退回單檔 best）。"""
    try:
        import yt_dlp  # type: ignore  # noqa: F401
    except ImportError:
        return None, (
            "未安裝 yt-dlp。請在「本程式實際使用的」Python 環境中執行（勿只用系統預設 pip）：\n"
            "  python -m pip install -U yt-dlp\n"
            "或在專案目錄：python -m pip install -r python_service/requirements.txt\n"
            "若曾設定環境變數 VOICE_TRANSLATOR_PYTHON，請對該 python.exe 執行上述指令。"
        )

    url = url.strip()
    is_youtube = _is_youtube_url(url)

    emit(
        {
            "type": "progress",
            "value": 0.03,
            "message": "正在從連結下載影片…",
        }
    )

    def _fmt_download_err(stderr: str, stdout: str) -> str:
        msg = (stderr or stdout or "").strip()
        if len(msg) > 1500:
            msg = msg[:1500] + "…"
        return (
            f"下載失敗（yt-dlp）：{msg}\n"
            "請嘗試：① pip install -U yt-dlp ② 安裝 ffmpeg 並加入系統 PATH "
            "③ 若為 YouTube，請確認影片可公開播放、無年齡／地區限制。"
        )

    def _build_cmd(
        outtmpl: str,
        format_spec: str,
        merge_output_format: str | None,
        include_youtube_extractor_args: bool,
    ) -> list[str]:
        cmd: list[str] = [
            sys.executable,
            "-m",
            "yt_dlp",
            "-f",
            format_spec,
            "-o",
            outtmpl,
            "--no-playlist",
            "--quiet",
            "--no-progress",
            "--no-warnings",
            "--retries",
            "3",
            "--fragment-retries",
            "3",
            "--socket-timeout",
            "40",
        ]
        if merge_output_format:
            cmd.extend(["--merge-output-format", merge_output_format])
        ffmpeg_path = (
            os.environ.get("FFMPEG_PATH") or os.environ.get("VOICE_TRANSLATOR_FFMPEG") or ""
        ).strip()
        if not ffmpeg_path:
            ffmpeg_path = _ffmpeg_executable() or ""
        if ffmpeg_path:
            cmd.extend(["--ffmpeg-location", ffmpeg_path])
        if include_youtube_extractor_args and is_youtube:
            cmd.extend(
                ["--extractor-args", "youtube:player_client=android;player_client=web"]
            )
        cmd.append(url)
        return cmd

    # (format_spec, merge_output_format or None) — 先合併為 mp4，再 mkv，最後單檔 best
    strategies: list[tuple[str, str | None]] = [
        ("bestvideo+bestaudio/best", "mp4"),
        ("bestvideo+bestaudio/best", "mkv"),
        ("best", None),
    ]

    last_err: str | None = None
    for fmt, merge_fmt in strategies:
        for use_youtube_args in (
            [True, False] if is_youtube else [False]
        ):
            tmpdir = tempfile.mkdtemp(prefix="voice_translator_dl_")
            outtmpl = os.path.join(tmpdir, "media.%(ext)s")
            cmd = _build_cmd(outtmpl, fmt, merge_fmt, use_youtube_args)
            r = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env={**os.environ},
            )
            if r.returncode != 0:
                last_err = _fmt_download_err(r.stderr, r.stdout)
                shutil.rmtree(tmpdir, ignore_errors=True)
                continue
            picked = _pick_largest_media_file(tmpdir)
            if picked:
                return picked, None
            last_err = "下載完成但未找到媒體檔。"
            shutil.rmtree(tmpdir, ignore_errors=True)

    return None, last_err or "無法下載媒體，請換一個連結或稍後再試。"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="音訊或影片路徑，或 http(s) 連結（將先下載再轉錄）")
    parser.add_argument(
        "--model",
        default=None,
        help="Whisper 模型名稱；未指定時依裝置選預設（見下方）",
    )
    parser.add_argument(
        "--device",
        default=os.environ.get("WHISPER_DEVICE", "auto"),
        help="cpu / cuda / auto",
    )
    parser.add_argument(
        "--compute-type",
        default=os.environ.get("WHISPER_COMPUTE", "default"),
        help="default / int8 / float16 等，依裝置而定",
    )
    parser.add_argument(
        "--probe-youtube-subs",
        action="store_true",
        help="僅檢查 --input 之 YouTube 連結是否具可解析字幕，印出一行 JSON 後結束。",
    )
    parser.add_argument(
        "--youtube-subs-mode",
        choices=["import", "whisper"],
        default=None,
        help="YouTube：import=下載字幕為逐字稿；whisper=略過字幕僅語音辨識。",
    )
    args = parser.parse_args()

    if args.probe_youtube_subs:
        r = _probe_youtube_subtitles_result((args.input or "").strip())
        print(json.dumps(r, ensure_ascii=False), flush=True)
        return 0

    input_path = (args.input or "").strip()
    if not input_path:
        emit({"type": "error", "message": "未提供輸入路徑或連結。"})
        return 1

    youtube_sub_cues: list[tuple[float, float, str]] = []
    youtube_sub_display = ""
    youtube_sub_lang = ""

    if _is_http_url(input_path):
        emit(
            {
                "type": "progress",
                "value": 0.01,
                "message": "正在從連結取得媒體…",
            }
        )
        url_for_dl = input_path.strip()
        stream_title = _extract_stream_title(url_for_dl)
        if _is_youtube_url(url_for_dl) and args.youtube_subs_mode != "whisper":
            emit(
                {
                    "type": "progress",
                    "value": 0.015,
                    "message": (
                        "正在載入 YouTube 字幕…"
                        if args.youtube_subs_mode == "import"
                        else "正在嘗試載入 YouTube 字幕…"
                    ),
                }
            )
            cues, sub_disp, sub_lang = _try_fetch_youtube_subtitle_segments(url_for_dl)
            if cues:
                youtube_sub_cues = cues
                youtube_sub_display = sub_disp
                youtube_sub_lang = sub_lang
        local_path, dl_err = _download_media_from_url(url_for_dl)
        if dl_err or not local_path:
            emit({"type": "error", "message": dl_err or "無法下載媒體。"})
            return 1
        downloaded_payload: dict = {
            "type": "downloaded",
            "path": local_path,
        }
        if stream_title:
            downloaded_payload["title"] = stream_title
        emit(downloaded_payload)
        input_path = local_path

    _register_windows_cuda_runtime_paths()

    if youtube_sub_cues:
        want_tw = _subtitle_lang_should_traditionalize(youtube_sub_lang)
        zh_tw_cc = _make_zh_traditional_converter() if want_tw else None
        if want_tw and zh_tw_cc is None:
            emit(
                {
                    "type": "progress",
                    "value": 0.055,
                    "message": "字幕為中文，但缺少 opencc（請 pip install opencc-python-reimplemented），字體維持來源字幕原樣。",
                }
            )
        emit(
            {
                "type": "progress",
                "value": 0.06,
                "message": (
                    f"已套用 YouTube 字幕（{youtube_sub_display}），略過語音辨識。"
                    + ("（中文已轉為台灣繁體）" if zh_tw_cc is not None else "")
                ),
            }
        )
        count = 0
        for t0, t1, text in youtube_sub_cues:
            text = (text or "").strip()
            if not text:
                continue
            if zh_tw_cc is not None:
                text = zh_tw_cc.convert(text)
            emit(
                {
                    "type": "segment",
                    "start": float(t0),
                    "end": float(t1),
                    "text": text,
                }
            )
            count += 1
            if count % 40 == 0:
                emit(
                    {
                        "type": "progress",
                        "value": min(0.95, 0.08 + count * 0.0015),
                        "message": f"已輸出 {count} 段字幕…",
                    }
                )
        emit(
            {
                "type": "progress",
                "value": 1.0,
                "message": f"完成，共 {count} 段（YouTube 字幕）",
            }
        )
        _exit_zero_skip_interpreter_teardown()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        emit(
            {
                "type": "error",
                "message": "未安裝 faster-whisper。請執行：pip install -r python_service/requirements.txt",
            }
        )
        return 1

    device = _resolve_whisper_device(args.device)

    compute_type = args.compute_type
    if compute_type == "default":
        compute_type = "float16" if device == "cuda" else "int8"

    # 未指定時：GPU 用 large-v3；CPU 用 medium（large-v3 在 CPU 上首次下載與載入極慢，易誤以為當機）
    model_name = args.model or os.environ.get("WHISPER_MODEL")
    if not model_name:
        model_name = "large-v3" if device == "cuda" else "medium"

    emit(
        {
            "type": "progress",
            "value": 0.0,
            "message": f"載入模型 {model_name}（{device}）…",
        }
    )

    load_result: dict = {}
    load_error: list = []

    def load_worker() -> None:
        try:
            load_result["model"] = WhisperModel(
                model_name,
                device=device,
                compute_type=compute_type,
            )
        except Exception as e:
            load_error.append(e)

    t = threading.Thread(target=load_worker, daemon=True)
    t.start()
    heartbeat_sec = 4
    n = 0
    while t.is_alive():
        t.join(timeout=heartbeat_sec)
        if not t.is_alive():
            break
        n += 1
        elapsed = n * heartbeat_sec
        hint = (
            "首次下載模型可能需數分鐘，請勿關閉程式。"
            if device == "cpu"
            else "首次下載可能需一些時間…"
        )
        emit(
            {
                "type": "progress",
                "value": min(0.08, 0.02 + n * 0.01),
                "message": f"載入模型 {model_name}（{device}）… 已等候約 {elapsed} 秒。{hint}",
            }
        )

    if load_error:
        le = load_error[0]
        err_text = _append_cuda_hint_if_dll_error(f"載入模型失敗：{le}", le)
        emit({"type": "error", "message": err_text})
        return 1

    model = load_result["model"]

    transcribe_path = input_path
    transcribe_temp_wav: str | None = None
    if _should_extract_audio_before_transcribe(input_path):
        emit(
            {
                "type": "progress",
                "value": 0.045,
                "message": "正在從影片提取音訊（ffmpeg）…",
            }
        )
        w, ex_err = _extract_audio_wav_for_whisper(input_path)
        if ex_err or not w:
            emit({"type": "error", "message": ex_err or "無法提取音訊。"})
            return 1
        transcribe_path = w
        transcribe_temp_wav = w

    emit({"type": "progress", "value": 0.05, "message": "開始轉錄…"})

    try:
        try:
            segments, info = model.transcribe(
                transcribe_path,
                beam_size=5,
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=500),
                language=None,
            )
        except Exception as e:
            base = f"轉錄失敗：{e}\n{traceback.format_exc()}"
            emit(
                {
                    "type": "error",
                    "message": _append_cuda_hint_if_dll_error(base, e),
                }
            )
            return 1

        lang = getattr(info, "language", None) or ""
        is_zh = _whisper_lang_is_chinese(lang)
        zh_tw_cc = _make_zh_traditional_converter() if is_zh else None
        if is_zh and zh_tw_cc is None:
            emit(
                {
                    "type": "progress",
                    "value": 0.08,
                    "message": "偵測為中文，但缺少 opencc（請 pip install opencc-python-reimplemented），輸出可能為簡體。",
                }
            )
        emit(
            {
                "type": "progress",
                "value": 0.1,
                "message": f"偵測語言：{lang}" if lang else "轉錄中…",
            }
        )

        total_dur = float(getattr(info, "duration", 0.0) or 0.0)
        if total_dur <= 0:
            probed = _probe_media_duration_seconds(transcribe_path)
            if probed is not None and probed > 0:
                total_dur = probed

        count = 0
        max_end = 0.0
        last_shown_p = 0.1
        last_emit_m = time.monotonic()
        try:
            for seg in segments:
                text = (seg.text or "").strip()
                if not text:
                    continue
                if zh_tw_cc is not None:
                    text = zh_tw_cc.convert(text)
                emit(
                    {
                        "type": "segment",
                        "start": float(seg.start),
                        "end": float(seg.end),
                        "text": text,
                    }
                )
                count += 1
                try:
                    end_t = float(seg.end)
                except (TypeError, ValueError):
                    end_t = 0.0
                if end_t > max_end:
                    max_end = end_t

                if total_dur > 0:
                    ratio = min(1.0, max(0.0, max_end / total_dur))
                    p = min(0.95, 0.1 + 0.85 * ratio)
                else:
                    # 無總長度時勿再以「段數」線性衝到 95%，改為漸近避免長片誤導
                    p = min(
                        0.95,
                        0.1 + 0.85 * (1.0 - 1.0 / (1.0 + count / 550.0)),
                    )

                now_m = time.monotonic()
                if p >= last_shown_p + 0.005 or now_m - last_emit_m >= 3.0:
                    last_shown_p = max(last_shown_p, p)
                    last_emit_m = now_m
                    if total_dur > 0:
                        msg = (
                            f"轉錄中 {_format_mmss(max_end)} / {_format_mmss(total_dur)}"
                            f"（{count} 段）"
                        )
                    else:
                        msg = f"已輸出 {count} 段…"
                    emit({"type": "progress", "value": p, "message": msg})
        except Exception as e:
            emit({"type": "error", "message": f"分段輸出失敗：{e}"})
            return 1

        emit({"type": "progress", "value": 1.0, "message": f"完成，共 {count} 段"})
    finally:
        if transcribe_temp_wav:
            try:
                os.unlink(transcribe_temp_wav)
            except OSError:
                pass
    _exit_zero_skip_interpreter_teardown()


if __name__ == "__main__":
    sys.exit(main())
