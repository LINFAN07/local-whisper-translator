"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FilePlus2, Link2, Sparkles, Upload } from "lucide-react";
import { DropZone } from "@/components/drop-zone";
import { MediaPlayer } from "@/components/media-player";
import { TranscriptPanel } from "@/components/transcript-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Card } from "@/components/ui/card";
import { useAppStore } from "@/lib/store";
import { AiExportPanel } from "@/components/ai-export-panel";

function isHttpUrlString(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isYoutubeHttpUrl(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (!t.startsWith("http://") && !t.startsWith("https://")) return false;
  return (
    t.includes("youtube.com") ||
    t.includes("youtu.be") ||
    t.includes("youtube-nocookie.com")
  );
}

export function MainWorkspace() {
  const mediaPath = useAppStore((s) => s.mediaPath);
  const mediaSrc = useAppStore((s) => s.mediaSrc);
  const mediaName = useAppStore((s) => s.mediaName);
  const setMedia = useAppStore((s) => s.setMedia);
  const setCurrentTaskId = useAppStore((s) => s.setCurrentTaskId);
  const setTaskCreatedAt = useAppStore((s) => s.setTaskCreatedAt);
  const setSummary = useAppStore((s) => s.setSummary);
  const progress = useAppStore((s) => s.progress);
  const status = useAppStore((s) => s.status);
  const statusMessage = useAppStore((s) => s.statusMessage);
  const clearSegments = useAppStore((s) => s.clearSegments);
  const setProgress = useAppStore((s) => s.setProgress);
  const setStatus = useAppStore((s) => s.setStatus);
  const setPlaybackTime = useAppStore((s) => s.setPlaybackTime);

  const [urlDraft, setUrlDraft] = useState("");
  const [youtubeSubPrompt, setYoutubeSubPrompt] = useState<{
    input: string;
    label: string;
  } | null>(null);
  const [probingYoutube, setProbingYoutube] = useState(false);
  const syncedMediaPathRef = useRef<string | null>(null);

  useEffect(() => {
    const p = mediaPath?.trim() ?? "";
    const isHttp =
      p.startsWith("http://") || p.startsWith("https://");
    if (!isHttp || mediaSrc) {
      syncedMediaPathRef.current = p || null;
      return;
    }
    if (syncedMediaPathRef.current !== p) {
      syncedMediaPathRef.current = p;
      setUrlDraft(p);
    }
  }, [mediaPath, mediaSrc]);

  const applyMediaUrl = useCallback(() => {
    const t = urlDraft.trim();
    if (!t) {
      setStatus("error", "請貼上連結。");
      return;
    }
    if (!isHttpUrlString(t)) {
      setStatus(
        "error",
        "請貼上有效的 http(s) 連結。常見平台如 YouTube、Bilibili、Vimeo、SoundCloud、Twitch、ニコニコ動畫、Podcast 等，只要可由 yt-dlp 解析且內容可公開存取即可（實際以 yt-dlp 支援清單為準）。",
      );
      return;
    }
    let label: string;
    try {
      label = `${new URL(t).hostname} 連結`;
    } catch {
      label = "網路連結";
    }
    setMedia({ src: null, path: t, name: label });
    setUrlDraft(t);
    clearSegments();
    setCurrentTaskId(null);
    setTaskCreatedAt(null);
    setSummary(null);
    setProgress(0, "");
    setStatus("idle");
  }, [
    clearSegments,
    setCurrentTaskId,
    setMedia,
    setProgress,
    setStatus,
    setSummary,
    setTaskCreatedAt,
    urlDraft,
  ]);

  const loadElectronPath = useCallback(
    async (paths: string[]) => {
      const p = paths[0];
      if (!p || !window.electronAPI) return;
      const url = await window.electronAPI.getFileUrl(p);
      if (!url) return;
      const name = p.split(/[/\\]/).pop() ?? p;
      setMedia({ src: url, path: p, name });
      setUrlDraft("");
      clearSegments();
      setCurrentTaskId(null);
      setTaskCreatedAt(null);
      setSummary(null);
      setProgress(0, "");
      setStatus("idle");
    },
    [
      clearSegments,
      setCurrentTaskId,
      setMedia,
      setProgress,
      setStatus,
      setSummary,
      setTaskCreatedAt,
    ],
  );

  const onDropFiles = useCallback(
    (files: FileList | File[]) => {
      const f = Array.from(files)[0];
      if (!f) return;
      const name = f.name;
      const url = URL.createObjectURL(f);
      setMedia({ src: url, path: null, name });
      setUrlDraft("");
      clearSegments();
      setCurrentTaskId(null);
      setTaskCreatedAt(null);
      setSummary(null);
      setProgress(0, "");
      setStatus("idle");
    },
    [
      clearSegments,
      setCurrentTaskId,
      setMedia,
      setProgress,
      setStatus,
      setSummary,
      setTaskCreatedAt,
    ],
  );

  const runTranscribeWithOptions = useCallback(
    async (input: string, youtubeSubsMode?: "import" | "whisper") => {
      clearSegments();
      setCurrentTaskId(null);
      setTaskCreatedAt(null);
      setSummary(null);
      setProgress(0, "開始…");
      setStatus("processing");
      const api = window.electronAPI!;
      const payload =
        youtubeSubsMode !== undefined ?
          { input, youtubeSubsMode }
        : input;
      const r = await api.transcribeStart(payload);
      if (!r?.ok) {
        setStatus("error", r?.error ?? "無法啟動轉錄");
      }
    },
    [
      clearSegments,
      setCurrentTaskId,
      setProgress,
      setStatus,
      setSummary,
      setTaskCreatedAt,
    ],
  );

  const startTranscribe = useCallback(async () => {
    const pathOrUrl = mediaPath?.trim() ?? "";
    const isRemoteUrl =
      pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://");
    if (!isRemoteUrl && !mediaSrc) return;

    const api = window.electronAPI;
    if (!api?.transcribeStart) {
      setStatus(
        "error",
        "目前為瀏覽器預覽模式，無法執行本機轉錄。請關閉此分頁，在專案目錄執行 npm run electron:dev，或使用已安裝的桌面版。",
      );
      return;
    }

    if (!isRemoteUrl && !mediaPath) {
      setStatus(
        "error",
        "缺少檔案本機路徑。請在桌面版以「選擇檔案」或將檔案拖入區域（勿用瀏覽器另開的預覽分頁選檔）。",
      );
      return;
    }

    const input = isRemoteUrl ? pathOrUrl : mediaPath!.trim();
    if (!input) return;

    const useYoutubeProbe =
      isRemoteUrl &&
      isYoutubeHttpUrl(input) &&
      typeof api.youtubeProbeSubtitles === "function";

    if (useYoutubeProbe) {
      setProbingYoutube(true);
      setProgress(0, "正在檢查 YouTube 字幕…");
      setStatus("idle", "");
      let probe;
      try {
        probe = await api.youtubeProbeSubtitles(input);
      } finally {
        setProbingYoutube(false);
        setProgress(0, "");
      }
      if (!probe?.ok) {
        await runTranscribeWithOptions(input, "whisper");
        return;
      }
      if (probe.available) {
        setYoutubeSubPrompt({
          input,
          label: (probe.label ?? "").trim() || "可用字幕",
        });
        return;
      }
      await runTranscribeWithOptions(input, "whisper");
      return;
    }

    await runTranscribeWithOptions(input);
  }, [
    mediaPath,
    mediaSrc,
    runTranscribeWithOptions,
    setProgress,
    setStatus,
  ]);

  const cancelTranscribe = useCallback(async () => {
    await window.electronAPI?.transcribeCancel?.();
    setStatus("idle", "已取消");
  }, [setStatus]);

  const startNewImport = useCallback(() => {
    if (status === "processing" || probingYoutube) return;
    if (mediaSrc?.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(mediaSrc);
      } catch {
        /* ignore */
      }
    }
    setMedia({ src: null, path: null, name: null });
    clearSegments();
    setCurrentTaskId(null);
    setTaskCreatedAt(null);
    setSummary(null);
    setProgress(0, "");
    setStatus("idle", "");
    setPlaybackTime(0);
    setUrlDraft("");
    syncedMediaPathRef.current = null;
    setYoutubeSubPrompt(null);
    setProbingYoutube(false);
  }, [
    clearSegments,
    mediaSrc,
    probingYoutube,
    setCurrentTaskId,
    setMedia,
    setPlaybackTime,
    setProgress,
    setStatus,
    setSummary,
    setTaskCreatedAt,
    status,
  ]);

  const busy =
    status === "processing" ||
    probingYoutube ||
    youtubeSubPrompt !== null;

  const pathOrUrlTrim = mediaPath?.trim() ?? "";
  const isRemoteUrl =
    pathOrUrlTrim.startsWith("http://") || pathOrUrlTrim.startsWith("https://");
  const canStartTranscribe =
    Boolean(mediaPath) && (isRemoteUrl || Boolean(mediaSrc));

  const pendingUrlOnly =
    !mediaSrc &&
    typeof mediaPath === "string" &&
    (mediaPath.startsWith("http://") || mediaPath.startsWith("https://"));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
      <div className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">工作區</h1>
            <p className="text-sm text-muted-foreground">
              {mediaName ?? "尚未匯入檔案"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              className="gap-2"
              disabled={busy || !canStartTranscribe}
              onClick={startTranscribe}
            >
              <Sparkles className="size-4" />
              開始轉錄
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!busy}
              onClick={cancelTranscribe}
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-2"
              disabled={busy}
              title="清除目前媒體與逐字稿，回到貼連結／選檔案"
              onClick={startNewImport}
            >
              <FilePlus2 className="size-4" />
              匯入新檔案
            </Button>
          </div>
        </div>

        {status === "error" && statusMessage ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {statusMessage}
          </div>
        ) : null}

        {mediaSrc ?
          <Card className="w-full min-w-0 shrink-0 overflow-hidden p-4">
            <MediaPlayer />
          </Card>
        : <div className="grid w-full min-w-0 shrink-0 gap-4 md:grid-cols-2">
            <Card className="flex min-h-0 flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Link2 className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-sm font-medium">貼上網址</span>
              </div>
              {pendingUrlOnly ? (
                <div className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground">
                  已套用連結。按下「開始轉錄」將由{" "}
                  <code className="rounded bg-muted/80 px-1 py-0.5">yt-dlp</code>{" "}
                  下載至本機，完成後此處會改為媒體預覽並與逐字稿對時。
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                請安裝{" "}
                <code className="rounded bg-muted px-1 py-0.5">yt-dlp</code> 與{" "}
                <code className="rounded bg-muted px-1 py-0.5">ffmpeg</code>
                。可涵蓋多數常見影音站（YouTube、Bilibili 等，實際以 yt-dlp 為準）；下載與轉錄皆在本機執行。
                YouTube 若偵測到字幕，開始轉錄前可選擇直接帶入或使用 Whisper。
              </p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  type="url"
                  name="media-url"
                  placeholder="https://…（影片／音訊頁面網址）"
                  value={urlDraft}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyMediaUrl();
                  }}
                  disabled={busy}
                  className="sm:flex-1"
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  className="shrink-0"
                  onClick={applyMediaUrl}
                >
                  套用連結
                </Button>
              </div>
            </Card>

            <Card className="flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Upload className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-sm font-medium">本機檔案</span>
              </div>
              <DropZone
                compact
                disabled={busy}
                onFiles={onDropFiles}
                onElectronPaths={loadElectronPath}
              />
            </Card>
          </div>
        }

        {(busy || progress > 0) && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>處理進度</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <Progress value={progress} className="h-2" />
            {statusMessage ? (
              <p className="text-xs text-muted-foreground">{statusMessage}</p>
            ) : null}
          </div>
        )}

        <AiExportPanel />
      </div>

      <div className="relative z-0 flex h-[min(360px,42vh)] min-h-0 w-full shrink-0 border-t border-border lg:h-full lg:w-[min(420px,38vw)] lg:border-l lg:border-t-0">
        <TranscriptPanel />
      </div>

      {youtubeSubPrompt ?
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="yt-sub-choice-title"
        >
          <Card className="max-w-md shadow-lg">
            <div className="space-y-4 p-5">
              <h2
                id="yt-sub-choice-title"
                className="text-base font-semibold tracking-tight"
              >
                偵測到 YouTube 字幕
              </h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                此連結有可用的字幕（{youtubeSubPrompt.label}）。請選擇直接使用字幕，或以
                Whisper 重新辨識語音。
              </p>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setYoutubeSubPrompt(null);
                  }}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const p = youtubeSubPrompt;
                    if (!p) return;
                    setYoutubeSubPrompt(null);
                    void runTranscribeWithOptions(p.input, "whisper");
                  }}
                >
                  使用 Whisper 轉錄
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    const p = youtubeSubPrompt;
                    if (!p) return;
                    setYoutubeSubPrompt(null);
                    void runTranscribeWithOptions(p.input, "import");
                  }}
                >
                  帶入 YouTube 字幕
                </Button>
              </div>
            </div>
          </Card>
        </div>
      : null}
    </div>
  );
}
