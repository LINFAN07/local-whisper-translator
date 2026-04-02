"""
JSONL 協議（每行一個 JSON）：
- {"type":"progress","value":0.0~1.0,"message":"..."}
- {"type":"segment","start":秒,"end":秒,"text":"..."}
- {"type":"error","message":"..."}
- {"type":"downloaded","path":"本機媒體絕對路徑","title":"可選，串流標題"}（僅在輸入為 http(s) 連結且下載成功後送出，供前端播放）
http(s) 輸入時由 yt-dlp 下載影片（優先合併為 mp4，失敗則 mkv，再退回單檔 best；支援多數常見影音站）。
環境變數 WHISPER_MODEL 可覆寫模型名稱；未設定時 GPU 預設 large-v3，CPU 預設 medium（較適合無獨顯環境）。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import traceback


def emit(obj: dict) -> None:
    line = json.dumps(obj, ensure_ascii=False)
    print(line, flush=True)
    # 同步寫入 stderr，讓 Electron 在 stdout 緩衝異常時仍能從 stderr 轉發錯誤
    if obj.get("type") == "error":
        try:
            print(line, file=sys.stderr, flush=True)
        except OSError:
            pass


def _is_http_url(s: str) -> bool:
    t = (s or "").strip()
    return t.startswith("http://") or t.startswith("https://")


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
    lu = url.lower()
    is_youtube = "youtube.com" in lu or "youtu.be" in lu

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
    args = parser.parse_args()

    input_path = (args.input or "").strip()
    if not input_path:
        emit({"type": "error", "message": "未提供輸入路徑或連結。"})
        return 1

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

    device = args.device
    if device == "auto":
        try:
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "cpu"

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
        emit({"type": "error", "message": f"載入模型失敗：{load_error[0]}"})
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
            emit(
                {
                    "type": "error",
                    "message": f"轉錄失敗：{e}\n{traceback.format_exc()}",
                }
            )
            return 1

        lang = getattr(info, "language", None) or ""
        emit(
            {
                "type": "progress",
                "value": 0.1,
                "message": f"偵測語言：{lang}" if lang else "轉錄中…",
            }
        )

        count = 0
        try:
            for seg in segments:
                text = (seg.text or "").strip()
                if not text:
                    continue
                emit(
                    {
                        "type": "segment",
                        "start": float(seg.start),
                        "end": float(seg.end),
                        "text": text,
                    }
                )
                count += 1
                if count % 10 == 0:
                    emit(
                        {
                            "type": "progress",
                            "value": min(0.95, 0.1 + count * 0.01),
                            "message": f"已輸出 {count} 段…",
                        }
                    )
        except Exception as e:
            emit({"type": "error", "message": f"分段輸出失敗：{e}"})
            return 1

        emit({"type": "progress", "value": 1.0, "message": f"完成，共 {count} 段"})
        return 0
    finally:
        if transcribe_temp_wav:
            try:
                os.unlink(transcribe_temp_wav)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
