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

export function MainWorkspace({ isActive = true }: { isActive?: boolean }) {
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
  const segments = useAppStore((s) => s.segments);
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
  /** 避免「開始轉錄」的 useCallback 漏列 urlDraft 導致閉包仍為空字串、靜默失敗 */
  const urlDraftRef = useRef(urlDraft);
  urlDraftRef.current = urlDraft;

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

  /** 將輸入框的連結寫入 store；無效則設錯誤並回傳 false */
  const commitMediaUrlFromText = useCallback((raw: string): boolean => {
    const t = raw.trim();
    if (!t) {
      setStatus("error", "請貼上連結。");
      return false;
    }
    if (!isHttpUrlString(t)) {
      setStatus(
        "error",
        "請貼上有效的 http(s) 連結。常見平台如 YouTube、Bilibili、Vimeo、SoundCloud、Twitch、ニコニコ動畫、Podcast 等，只要可由 yt-dlp 解析且內容可公開存取即可（實際以 yt-dlp 支援清單為準）。",
      );
      return false;
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
    return true;
  }, [
    clearSegments,
    setCurrentTaskId,
    setMedia,
    setProgress,
    setStatus,
    setSummary,
    setTaskCreatedAt,
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
    const draft = urlDraftRef.current.trim();
    if (draft) {
      if (!commitMediaUrlFromText(draft)) return;
    }

    const { mediaPath: pathFromStore, mediaSrc: srcFromStore } =
      useAppStore.getState();
    const pathOrUrl = pathFromStore?.trim() ?? "";
    const isRemoteUrl =
      pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://");
    if (!isRemoteUrl && !srcFromStore) return;

    const api = window.electronAPI;
    if (!api?.transcribeStart) {
      setStatus(
        "error",
        "目前為瀏覽器預覽模式，無法執行本機轉錄。請關閉此分頁，在專案目錄執行 npm run electron:dev，或使用已安裝的桌面版。",
      );
      return;
    }

    if (!isRemoteUrl && !pathFromStore) {
      setStatus(
        "error",
        "缺少檔案本機路徑。請在桌面版以「選擇檔案」或將檔案拖入區域（勿用瀏覽器另開的預覽分頁選檔）。",
      );
      return;
    }

    const input = isRemoteUrl ? pathOrUrl : pathFromStore!.trim();
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
  }, [commitMediaUrlFromText, runTranscribeWithOptions, setProgress, setStatus]);

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
          </div>
          <div className="flex flex-wrap gap-2">
            {status === "processing" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!busy}
                onClick={cancelTranscribe}
              >
                取消
              </Button>
            ) : segments.length === 0 ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  className="gap-2"
                  disabled={busy || (!canStartTranscribe && !urlDraft.trim())}
                  onClick={startTranscribe}
                >
                  <Sparkles className="size-4" />
                  開始轉錄
                </Button>
                {mediaSrc && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={startNewImport}
                  >
                    回主頁
                  </Button>
                )}
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="default"
                className="gap-2"
                disabled={busy}
                title="清除目前媒體與逐字稿，回到貼連結／選檔案"
                onClick={startNewImport}
              >
                <FilePlus2 className="size-4" />
                匯入新檔案
              </Button>
            )}
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
            {isActive ?
              <MediaPlayer />
            : <div className="flex min-h-[140px] items-center justify-center px-4 text-center text-xs text-muted-foreground">
                目前於「字幕翻譯」工作區。切回「轉錄」可預覽與控制播放。
              </div>
            }
          </Card>
        : <div className="flex flex-1 flex-col items-center justify-center py-8">
            <div className="relative w-full max-w-xl">
              {/* 底層 DropZone：負責拖放感應與邏輯 */}
              <DropZone
                onFiles={onDropFiles}
                onElectronPaths={loadElectronPath}
                disabled={busy}
                openOnSurfaceClick={false}
                className="absolute inset-0 z-0 opacity-0"
              />

              {/* 上層視覺卡片：參考圖片設計 */}
              <Card className="pointer-events-none relative z-10 w-full overflow-hidden border-border/50 bg-card/40 p-10 shadow-2xl">
                <div className="flex flex-col items-center space-y-8 text-center">
                  {/* 頂部雙圖示 */}
                  <div className="flex gap-4">
                    <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary/80">
                      <Link2 size={32} />
                    </div>
                    <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary/80">
                      <Upload size={32} />
                    </div>
                  </div>

                  {/* 文案區 */}
                  <div className="space-y-2">
                    <h2 className="text-xl font-semibold tracking-tight text-foreground">
                      匯入媒體檔案
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      貼上 YouTube / Bilibili 連結，或直接將檔案拖放到此處
                    </p>
                  </div>

                  {/* 網址輸入：需要 pointer-events-auto 讓 Input/Button 可用 */}
                  <div className="pointer-events-auto flex w-full gap-2">
                    <Input
                      type="url"
                      placeholder="https://..."
                      value={urlDraft}
                      onChange={(e) => setUrlDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") startTranscribe();
                      }}
                      disabled={busy}
                      className="h-12 rounded-xl border-border/50 bg-background/50"
                      autoComplete="off"
                    />
                  </div>

                  <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/40">
                    OR
                  </div>

                  {/* 檔案選取：需要 pointer-events-auto */}
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => (DropZone as any).triggerPicker?.()}
                    className="pointer-events-auto h-12 rounded-xl bg-white px-10 font-semibold text-black hover:bg-slate-100"
                  >
                    選擇本機檔案
                  </Button>
                </div>
              </Card>
            </div>
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
