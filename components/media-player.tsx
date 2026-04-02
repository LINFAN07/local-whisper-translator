"use client";

import { useEffect, useRef } from "react";
import { Film } from "lucide-react";
import { useAppStore } from "@/lib/store";

const VIDEO_EXT = new Set([
  ".mp4",
  ".mkv",
  ".webm",
  ".mov",
  ".avi",
  ".m4v",
  ".flv",
]);

const AUDIO_EXT = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".flac",
  ".wma",
]);

function getExtension(input: string | null): string | null {
  if (!input) return null;
  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  const plainDot = raw.lastIndexOf(".");
  if (plainDot >= 0) {
    return raw.slice(plainDot);
  }

  // Handle URLs like ".../video.mp4?token=..."
  try {
    const u = new URL(raw);
    const pathname = u.pathname.toLowerCase();
    const dot = pathname.lastIndexOf(".");
    if (dot >= 0) {
      return pathname.slice(dot);
    }
  } catch {
    // Ignore URL parsing errors and continue with other heuristics.
  }

  return null;
}

function inferMediaKind(
  name: string | null,
  path: string | null,
  src: string | null,
): "video" | "audio" {
  const extensions = [name, path, src].map(getExtension).filter(Boolean) as string[];
  if (extensions.some((ext) => AUDIO_EXT.has(ext))) {
    return "audio";
  }
  if (extensions.some((ext) => VIDEO_EXT.has(ext))) {
    return "video";
  }

  const s = src?.toLowerCase() ?? "";
  if (s.includes("audio")) return "audio";
  if (s.includes("video")) return "video";

  // Unknown formats default to video player so users still get a full preview area.
  return "video";
}

export function MediaPlayer() {
  const mediaSrc = useAppStore((s) => s.mediaSrc);
  const mediaPath = useAppStore((s) => s.mediaPath);
  const mediaName = useAppStore((s) => s.mediaName);
  const setPlaybackTime = useAppStore((s) => s.setPlaybackTime);
  const seekTick = useAppStore((s) => s.seekTick);
  const seekTime = useAppStore((s) => s.seekTime);
  const ref = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  const mediaKind = inferMediaKind(mediaName, mediaPath, mediaSrc);
  const isVideo = mediaKind === "video";

  useEffect(() => {
    const el = ref.current;
    if (!el || seekTick === 0) return;
    el.currentTime = seekTime;
  }, [seekTick, seekTime]);

  const pendingUrlOnly =
    !mediaSrc &&
    typeof mediaPath === "string" &&
    (mediaPath.startsWith("http://") || mediaPath.startsWith("https://"));

  /** 固定 16:9 預覽區：用 aspect-video 依寬度算出高度，避免在 flex 裡塌成細條 */
  const previewFrameClass =
    "relative isolate aspect-video w-full max-w-full overflow-hidden rounded-lg border border-border bg-black shadow-sm";

  const placeholderInner = (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted/50 px-4 text-center text-sm text-muted-foreground">
      <div className="flex size-14 shrink-0 items-center justify-center rounded-full bg-background/90 ring-1 ring-border">
        <Film className="size-7 text-muted-foreground" aria-hidden />
      </div>
      {pendingUrlOnly ? (
        <>
          <span className="font-medium text-foreground">已設定網路連結</span>
          <span className="text-xs">
            按下「開始轉錄」後會下載影片至本機暫存，完成後在此預覽（與逐字稿對時）。
          </span>
        </>
      ) : (
        <>
          <span className="font-medium text-foreground">媒體預覽</span>
          <span className="text-xs">
            尚未匯入檔案。請拖放、選擇檔案或貼上網址，載入後將在此播放。
          </span>
        </>
      )}
    </div>
  );

  if (!mediaSrc) {
    return (
      <div className="w-full max-w-full shrink-0">
        <div className={previewFrameClass}>{placeholderInner}</div>
      </div>
    );
  }

  const onTimeUpdate = (
    e: React.SyntheticEvent<HTMLVideoElement | HTMLAudioElement>,
  ) => {
    setPlaybackTime(e.currentTarget.currentTime);
  };

  const videoProps = {
    className:
      "absolute inset-0 z-0 box-border h-full w-full object-contain bg-black",
    controls: true as const,
    preload: "metadata" as const,
    playsInline: true as const,
    src: mediaSrc,
    onTimeUpdate,
  };

  if (isVideo) {
    return (
      <div className="w-full max-w-full shrink-0 space-y-2">
        <div className={previewFrameClass}>
          <video ref={ref as React.RefObject<HTMLVideoElement>} {...videoProps} />
        </div>
        {mediaName ? (
          <p className="truncate text-xs text-muted-foreground">{mediaName}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="w-full max-w-full shrink-0 space-y-2">
      <div
        className={`${previewFrameClass} flex items-center justify-center bg-muted/30 p-6 pt-10`}
      >
        <p className="absolute left-3 top-3 z-10 text-xs text-muted-foreground">
          本機音訊（與逐字稿對時）
        </p>
        <audio
          ref={ref as React.RefObject<HTMLAudioElement>}
          className="h-11 w-full max-w-md rounded-md border border-border bg-background px-1 shadow-sm"
          controls
          src={mediaSrc}
          onTimeUpdate={onTimeUpdate}
        />
      </div>
      {mediaName ? (
        <p className="truncate text-xs text-muted-foreground">{mediaName}</p>
      ) : null}
    </div>
  );
}
