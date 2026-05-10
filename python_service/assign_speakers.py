"""
讀取 JSON payload（--payload 路徑），對媒體做說話人分離，將標籤對齊至逐字稿段落。
成功時於 stdout 輸出單行 JSON：{"ok":true,"updates":[{"id":"...","speaker":"SPEAKER_00"},...]}
失敗：{"ok":false,"error":"..."}

Payload 格式：
{"media_path": "本機音訊或影片", "segments": [{"id":"...", "start": 秒, "end": 秒}, ...]}
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback


def emit_result(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


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


def _should_extract_audio(path: str) -> bool:
    lower = path.lower()
    i = lower.rfind(".")
    if i < 0:
        return True
    return lower[i:] in _VIDEO_EXTENSIONS


def _extract_audio_wav(input_path: str) -> tuple[str | None, str | None]:
    ffmpeg = _ffmpeg_executable()
    if not ffmpeg:
        return None, (
            "找不到 ffmpeg。請安裝 imageio-ffmpeg（見 python_service/requirements.txt）"
            "或將 ffmpeg 加入 PATH。"
        )
    fd, out_wav = tempfile.mkstemp(suffix=".wav", prefix="vt_spk_")
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
            return None, "ffmpeg 輸出之 WAV 異常。"
    except OSError:
        try:
            os.unlink(out_wav)
        except OSError:
            pass
        return None, "無法讀取 ffmpeg 輸出檔。"
    return out_wav, None


def _overlap_seconds(t0: float, t1: float, s0: float, s1: float) -> float:
    left = max(t0, s0)
    right = min(t1, s1)
    if right > left:
        return right - left
    return 0.0


def _log_phase(msg: str) -> None:
    print(f"[assign_speakers] {msg}", file=sys.stderr, flush=True)


def _pyannote_waveform_input(wav_path: str) -> dict:
    """以記憶體波形餵給 pipeline，避開 Windows 上 torchcodec 異常時未定義的 AudioDecoder。"""
    import torch  # type: ignore

    try:
        import soundfile as sf  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "需要 soundfile 以載入 WAV。請執行：pip install -r python_service/requirements-speaker.txt"
        ) from e

    data, sr = sf.read(wav_path, dtype="float32", always_2d=True)
    if data.size == 0:
        raise ValueError("音訊檔無樣本資料。")
    t = torch.as_tensor(data, dtype=torch.float32)
    if t.shape[1] > 1:
        t = t.mean(dim=1, keepdim=True)
    waveform = t.transpose(0, 1).contiguous()
    return {"waveform": waveform, "sample_rate": int(sr)}


def _diarization_annotation(diarization_out) -> object:
    """pyannote 3.1+ 預設回傳 DiarizeOutput；legacy 模式才直接回傳 Annotation。"""
    ann = getattr(diarization_out, "speaker_diarization", None)
    return ann if ann is not None else diarization_out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--payload",
        required=True,
        help="JSON 檔：media_path + segments[{id,start,end}]",
    )
    args = parser.parse_args()

    p = (args.payload or "").strip()
    if not p or not os.path.isfile(p):
        emit_result({"ok": False, "error": "payload 檔案不存在。"})
        return 1

    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        emit_result({"ok": False, "error": f"無法讀取 payload：{e}"})
        return 1

    media_path = str(data.get("media_path") or "").strip()
    segments_in = data.get("segments")
    if not media_path or not os.path.isfile(media_path):
        emit_result({"ok": False, "error": "媒體檔不存在或路徑無效。"})
        return 1
    if not isinstance(segments_in, list) or not segments_in:
        emit_result({"ok": False, "error": "segments 為空。"})
        return 1

    hf = (
        os.environ.get("HF_TOKEN")
        or os.environ.get("HUGGING_FACE_HUB_TOKEN")
        or ""
    ).strip()
    if not hf:
        emit_result(
            {
                "ok": False,
                "error": "未設定 Hugging Face 權杖。請於程式「設置」頁填入，"
                "或設定環境變數 HF_TOKEN；並至 Hugging Face 接受 pyannote 模型使用條款。",
            }
        )
        return 1

    try:
        from pyannote.audio import Pipeline  # type: ignore
    except ImportError:
        emit_result(
            {
                "ok": False,
                "error": "未安裝 pyannote。請執行：pip install -r python_service/requirements-speaker.txt",
            }
        )
        return 1

    wav_path: str | None = None
    wav_temp: str | None = None
    if _should_extract_audio(media_path):
        wav_path, err = _extract_audio_wav(media_path)
        if err or not wav_path:
            emit_result({"ok": False, "error": err or "無法提取音訊。"})
            return 1
        wav_temp = wav_path
    else:
        wav_path = media_path

    _log_phase("音訊就緒，準備載入 pyannote 管道（首次執行可能下載模型，需較久）…")

    try:
        try:
            try:
                pipeline = Pipeline.from_pretrained(
                    "pyannote/speaker-diarization-3.1",
                    token=hf,
                )
            except TypeError:
                pipeline = Pipeline.from_pretrained(
                    "pyannote/speaker-diarization-3.1",
                    use_auth_token=hf,
                )
        except Exception as e:
            emit_result(
                {
                    "ok": False,
                    "error": f"無法載入說話人模型（請確認已接受 Hugging Face 條款且權杖有效）：{e}",
                }
            )
            return 1

        _log_phase("管道已載入，正在將模型放到運算裝置…")

        try:
            import torch  # type: ignore

            dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
            pipeline.to(dev)
        except Exception:
            pass

        _log_phase("開始對音訊做說話人分離（長音檔可能需數分鐘）…")

        try:
            raw_diarization = pipeline(_pyannote_waveform_input(wav_path))
        except Exception as e:
            emit_result(
                {
                    "ok": False,
                    "error": f"說話人分離失敗：{e}\n{traceback.format_exc()}",
                }
            )
            return 1

        annotation = _diarization_annotation(raw_diarization)
        if not hasattr(annotation, "itertracks"):
            emit_result(
                {
                    "ok": False,
                    "error": (
                        "說話人分離回傳了無法解讀的型別；請確認 pyannote.audio>=3.1 "
                        f"且模型為 speaker-diarization-3.1（實際型別：{type(raw_diarization).__name__}）。"
                    ),
                }
            )
            return 1

        _log_phase("分離完成，正在對齊逐字稿段落…")

        turns: list[tuple[float, float, str]] = []
        try:
            for turn, _track, speaker in annotation.itertracks(yield_label=True):
                lab = str(speaker) if speaker is not None else "UNKNOWN"
                turns.append((float(turn.start), float(turn.end), lab))
        except Exception as e:
            emit_result({"ok": False, "error": f"無法讀取分離結果：{e}"})
            return 1

        updates: list[dict] = []
        for seg in segments_in:
            if not isinstance(seg, dict):
                continue
            seg_id = str(seg.get("id") or "").strip()
            if not seg_id:
                continue
            try:
                t0 = float(seg["start"])
                t1 = float(seg["end"])
            except (KeyError, TypeError, ValueError):
                continue
            if t1 <= t0:
                t1 = t0 + 1e-3

            best_lab = "UNKNOWN"
            best_ov = 0.0
            for s0, s1, lab in turns:
                ov = _overlap_seconds(t0, t1, s0, s1)
                if ov > best_ov:
                    best_ov = ov
                    best_lab = lab
            updates.append({"id": seg_id, "speaker": best_lab})

        emit_result({"ok": True, "updates": updates})
        return 0
    finally:
        if wav_temp:
            try:
                os.unlink(wav_temp)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
