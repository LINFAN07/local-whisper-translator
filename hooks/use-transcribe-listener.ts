"use client";

import { useEffect } from "react";
import {
  mergeSavedTaskIntoHistoryList,
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
            speaker:
              typeof ev.speaker === "string" && ev.speaker.trim() ?
                ev.speaker.trim()
              : null,
          });
          break;
        case "error":
          setStatus("error", ev.message ?? "未知錯誤");
          break;
        case "done": {
          const code = ev.code ?? 0;
          const snap = useAppStore.getState();
          const hasTranscript = snap.segments.length > 0;
          const hadErrorStatus = snap.status === "error";
          /** Python 已送出逐字稿但程序以非零碼結束（常見：Windows 原生庫在關閉時崩潰） */
          const recoverOk = code !== 0 && hasTranscript && !hadErrorStatus;

          if (code !== 0 && !recoverOk) {
            if (hadErrorStatus) {
              // setProgress(0, "") 會清空 statusMessage，錯誤訊息會一閃即逝
              useAppStore.setState({ progress: 0 });
              break;
            }
            setProgress(0, "");
            const winAccessViolation = code === 3221226505;
            const hint = winAccessViolation ?
              "此代碼多為存取違規（0xC0000005），常發生在 GPU／faster-whisper 相關 DLL 於程序結束時卸載；可嘗試 WHISPER_DEVICE=cpu、更新顯示驅動，或重新安裝 python_service 依賴。"
            : "請確認已安裝 faster-whisper、yt-dlp 與 ffmpeg，並在終端機執行：cd python_service 後 pip install -r requirements.txt；若使用打包版，請確認內嵌 Python 環境已安裝上述套件。";
            setStatus(
              "error",
              `轉錄程序結束（代碼 ${code}）。未收到詳細錯誤訊息。${hint}`,
            );
          } else {
            const doneMsg =
              recoverOk ?
                "完成（程序回報異常結束，逐字稿已保留並寫入歷史）"
              : "完成";
            setProgress(100, doneMsg);
            setStatus("done", doneMsg);
            void (async () => {
              const s = useAppStore.getState();
              const segments = s.segments.map((seg) => ({ ...seg }));
              try {
                const r = await saveWorkspaceSnapshot({
                  segments,
                  currentTaskId: s.currentTaskId,
                  taskCreatedAt: s.taskCreatedAt,
                  mediaName: s.mediaName,
                  mediaPath: s.mediaPath,
                  summary: s.summary,
                });
                if (!r.ok) {
                  setStatus(
                    "error",
                    r.error ??
                      "轉錄已完成，但無法寫入歷史紀錄。請使用工具列「儲存紀錄」手動儲存。",
                  );
                  return;
                }
                mergeSavedTaskIntoHistoryList({
                  taskId: r.taskId,
                  createdAt: r.createdAt,
                  name: r.taskName,
                  mediaPath: r.savedMediaPath,
                  mediaName: r.savedMediaName,
                });
                useAppStore.setState({
                  currentTaskId: r.taskId,
                  taskCreatedAt: r.createdAt,
                });
                await refreshTasksInStore(useAppStore.getState().setTasks);
              } catch (e) {
                const msg =
                  e instanceof Error ? e.message : String(e);
                setStatus(
                  "error",
                  `轉錄已完成，但寫入歷史時發生錯誤：${msg}`,
                );
              }
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
