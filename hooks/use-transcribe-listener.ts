"use client";

import { useEffect } from "react";
import {
  refreshTasksInStore,
  saveWorkspaceSnapshot,
} from "@/lib/persist-task";
import { useAppStore } from "@/lib/store";
import type { TranscriptEvent } from "@/lib/types";

/** 訂閱 Electron 主進程轉發的轉錄 JSONL 事件 */
export function useTranscribeListener() {
  const appendSegment = useAppStore((s) => s.appendSegment);
  const setProgress = useAppStore((s) => s.setProgress);
  const setStatus = useAppStore((s) => s.setStatus);
  const setMedia = useAppStore((s) => s.setMedia);

  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.onTranscribeEvent) {
      return;
    }
    const off = window.electronAPI.onTranscribeEvent((ev: TranscriptEvent) => {
      switch (ev.type) {
        case "downloaded": {
          const p = ev.path;
          if (!p || !window.electronAPI?.getFileUrl) break;
          const title =
            typeof ev.title === "string" && ev.title.trim() ?
              ev.title.trim()
            : null;
          void window.electronAPI.getFileUrl(p).then((url) => {
            if (!url) return;
            const fallback = p.replace(/[/\\]/g, "/").split("/").pop() ?? p;
            setMedia({ src: url, path: p, name: title ?? fallback });
          });
          break;
        }
        case "progress": {
          if (useAppStore.getState().status === "error") break;
          const pct = Math.round(
            Math.min(100, Math.max(0, (ev.value ?? 0) * 100)),
          );
          setProgress(pct, ev.message ?? "");
          setStatus("processing", ev.message ?? "");
          break;
        }
        case "segment":
          appendSegment({
            start: ev.start,
            end: ev.end,
            text: ev.text,
          });
          if (useAppStore.getState().status !== "error") {
            setStatus("processing");
          }
          break;
        case "error":
          setStatus("error", ev.message ?? "未知錯誤");
          break;
        case "done": {
          const code = ev.code ?? 0;
          if (code !== 0) {
            if (useAppStore.getState().status === "error") {
              // setProgress(0, "") 會清空 statusMessage，錯誤訊息會一閃即逝
              useAppStore.setState({ progress: 0 });
              break;
            }
            setProgress(0, "");
            setStatus(
              "error",
              `轉錄程序結束（代碼 ${code}）。未收到詳細錯誤訊息。請確認已安裝 faster-whisper、yt-dlp 與 ffmpeg，並在終端機執行：cd python_service 後 pip install -r requirements.txt；若使用打包版，請確認內嵌 Python 環境已安裝上述套件。`,
            );
          } else {
            setProgress(100, "完成");
            setStatus("done");
            void (async () => {
              const s = useAppStore.getState();
              const r = await saveWorkspaceSnapshot({
                segments: s.segments,
                currentTaskId: s.currentTaskId,
                taskCreatedAt: s.taskCreatedAt,
                mediaName: s.mediaName,
                mediaPath: s.mediaPath,
                summary: s.summary,
              });
              if (!r.ok || !r.taskId) return;
              useAppStore.setState({
                currentTaskId: r.taskId,
                taskCreatedAt: r.createdAt ?? null,
              });
              await refreshTasksInStore(useAppStore.getState().setTasks);
            })();
          }
          break;
        }
        default:
          break;
      }
    });
    return off;
  }, [appendSegment, setMedia, setProgress, setStatus]);
}
