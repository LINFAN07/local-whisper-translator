"use client";

import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAppStore } from "@/lib/store";
import { formatTimestamp } from "@/lib/format-time";
import { cn } from "@/lib/utils";

const SEG_END_EPS = 0.05;

function isSegmentActive(t: number, start: number, end: number) {
  return t >= start && t < end + SEG_END_EPS;
}

export function TranscriptPanel() {
  const segments = useAppStore((s) => s.segments);
  const playbackTime = useAppStore((s) => s.playbackTime);
  const seekTick = useAppStore((s) => s.seekTick);
  const requestSeek = useAppStore((s) => s.requestSeek);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const segmentElRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const lastFollowedSegIdRef = useRef<string | null>(null);

  const hasTranslation = segments.some((s) => Boolean(s.translatedText?.trim()));

  useEffect(() => {
    if (!followRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [segments]);

  useEffect(() => {
    if (seekTick > 0) lastFollowedSegIdRef.current = null;
  }, [seekTick]);

  useEffect(() => {
    if (!followRef.current || segments.length === 0) return;
    const active = segments.find((s) =>
      isSegmentActive(playbackTime, s.start, s.end),
    );
    if (!active) return;
    if (active.id === lastFollowedSegIdRef.current) return;
    lastFollowedSegIdRef.current = active.id;
    const el = segmentElRefs.current.get(active.id);
    /** 置中可讀性較佳；若用 nearest 長段落時常只卡住邊緣 */
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [playbackTime, segments]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col border-l border-border bg-card/30">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">逐字稿</h2>
        <p className="text-xs text-muted-foreground">
          點擊時間戳可跳轉；播放中目前句會以主色標示並捲至畫面中央（需開啟下方「跟隨播放」）。
          {hasTranslation ? "並排顯示原文與譯文。" : ""}
          {!hasTranslation ? "翻譯後將並排顯示。" : null}
        </p>
      </div>
      <ScrollArea className="min-h-0 flex-1 px-2">
        <div className="space-y-1 py-2 pr-3">
          {hasTranslation ?
            <div className="grid grid-cols-2 gap-2 px-3 pb-1 text-xs font-medium text-muted-foreground">
              <span>原文</span>
              <span>譯文</span>
            </div>
          : null}
          {segments.length === 0 ?
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">
              轉錄結果將即時顯示於此
            </p>
          : segments.map((seg) => {
              const active = isSegmentActive(
                playbackTime,
                seg.start,
                seg.end,
              );
              return (
                <button
                  key={seg.id}
                  ref={(el) => {
                    if (el) segmentElRefs.current.set(seg.id, el);
                    else segmentElRefs.current.delete(seg.id);
                  }}
                  type="button"
                  onClick={() => requestSeek(seg.start)}
                  className={cn(
                    "flex w-full flex-col gap-1.5 rounded-lg border border-transparent px-3 py-2 text-left text-sm transition-[color,box-shadow,background-color,border-color]",
                    "scroll-my-6 outline-none hover:bg-muted/80 focus-visible:ring-2 focus-visible:ring-ring",
                    active ?
                      "border-primary/55 bg-primary/15 shadow-[inset_3px_0_0_0_var(--primary)] ring-1 ring-primary/25"
                    : null,
                  )}
                  aria-current={active ? "true" : undefined}
                >
                  <span
                    className={cn(
                      "font-mono text-xs",
                      active ? "font-medium text-primary" : "text-primary/80",
                    )}
                  >
                    {formatTimestamp(seg.start)} — {formatTimestamp(seg.end)}
                  </span>
                  {hasTranslation ?
                    <div className="grid grid-cols-2 gap-3 text-left">
                      <span
                        className={cn(
                          "leading-relaxed",
                          active ? "text-foreground" : "text-foreground/95",
                        )}
                      >
                        {seg.text}
                      </span>
                      <span
                        className={cn(
                          "leading-relaxed",
                          active ? "text-primary/90" : "text-muted-foreground",
                        )}
                      >
                        {seg.translatedText?.trim() || "—"}
                      </span>
                    </div>
                  : <span
                      className={cn(
                        "leading-relaxed",
                        active ? "text-foreground" : "text-foreground/95",
                      )}
                    >
                      {seg.text}
                    </span>}
                </button>
              );
            })
          }
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
      <label className="flex cursor-pointer items-center gap-2 border-t border-border px-4 py-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="rounded border-border"
          defaultChecked
          onChange={(e) => {
            const on = e.target.checked;
            followRef.current = on;
            if (on) lastFollowedSegIdRef.current = null;
          }}
        />
        跟隨播放與新段落（自動捲動）
      </label>
    </div>
  );
}
