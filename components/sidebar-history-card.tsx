"use client";

import { useEffect, useState } from "react";
import { Clapperboard, FileAudio, Trash2 } from "lucide-react";
import { cn, fileBasename } from "@/lib/utils";
import type { TaskItem } from "@/lib/types";

const VIDEO_RE = /\.(mp4|webm|mkv|mov|avi|m4v)$/i;
const IMAGE_RE = /\.(jpg|jpeg|png|gif|webp)$/i;

function isVideoPath(p: string | null | undefined): boolean {
  return !!p && VIDEO_RE.test(p);
}

function isImagePath(p: string | null | undefined): boolean {
  return !!p && IMAGE_RE.test(p);
}

function HistoryThumbnail({
  url,
  mediaPath,
}: {
  url: string | null;
  mediaPath: string | null | undefined;
}) {
  if (!url) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-muted/50">
        <Clapperboard className="size-7 text-muted-foreground/45" />
      </div>
    );
  }

  if (isImagePath(mediaPath)) {
    return (
      <img
        src={url}
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        loading="lazy"
      />
    );
  }

  if (isVideoPath(mediaPath)) {
    return (
      <video
        src={url}
        muted
        playsInline
        preload="metadata"
        className="absolute inset-0 h-full w-full bg-black object-cover"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          const dur = v.duration;
          const seek =
            dur && isFinite(dur) ? Math.min(1, Math.max(0.05, dur * 0.05)) : 0.1;
          v.currentTime = seek;
        }}
      />
    );
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-muted/50">
      <FileAudio className="size-7 text-muted-foreground/45" />
    </div>
  );
}

export function SidebarHistoryCard({
  task,
  onSelect,
  onDelete,
}: {
  task: TaskItem;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const p = task.mediaPath;
    if (!p || !window.electronAPI?.getFileUrl) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    void window.electronAPI.getFileUrl(p).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [task.mediaPath]);

  const displayTitle = (() => {
    const m = task.mediaName?.trim();
    if (m) return m;
    const p = task.mediaPath?.trim();
    if (p) {
      const b = fileBasename(p);
      if (b) return b;
    }
    return task.name.trim();
  })();
  const timeLabel = new Date(task.createdAt).toLocaleString("zh-TW", {
    dateStyle: "short",
    timeStyle: "short",
  });

  return (
    <li className="relative">
      <button
        type="button"
        onClick={() => onSelect(task.id)}
        className={cn(
          "group w-full overflow-hidden rounded-lg border border-sidebar-border bg-sidebar/80 text-left shadow-sm transition-colors",
          "hover:border-sidebar-primary/35 hover:bg-sidebar-accent/30",
        )}
      >
        <div className="relative aspect-video w-full overflow-hidden bg-muted/25">
          <HistoryThumbnail url={url} mediaPath={task.mediaPath} />
        </div>
        <div className="space-y-0.5 p-2 pt-1.5 pr-9">
          <p
            className="line-clamp-2 text-xs font-medium leading-snug text-sidebar-foreground"
            title={displayTitle}
          >
            {displayTitle || task.name}
          </p>
          <p className="text-[10px] leading-tight text-muted-foreground">{timeLabel}</p>
        </div>
      </button>
      <button
        type="button"
        className={cn(
          "absolute bottom-2 right-2 z-10 flex size-7 items-center justify-center rounded-md",
          "text-muted-foreground transition-colors",
          "hover:bg-destructive/15 hover:text-destructive",
          "focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none",
        )}
        aria-label={`刪除「${displayTitle || task.name}」`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDelete(task.id);
        }}
      >
        <Trash2 className="size-3.5" />
      </button>
    </li>
  );
}
