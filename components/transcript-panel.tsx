"use client";

import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useAppStore } from "@/lib/store";
import { formatTimestamp } from "@/lib/format-time";
import { readTimecodeClickMode } from "@/lib/timecode-click-mode";
import { cn } from "@/lib/utils";
import { TimecodeClickModeControls } from "@/components/timecode-click-mode-controls";
import { TranscriptHeaderActions } from "@/components/transcript-header-actions";

const SEG_END_EPS = 0.05;

function isSegmentActive(t: number, start: number, end: number) {
  return t >= start && t < end + SEG_END_EPS;
}

export function TranscriptPanel() {
  const segments = useAppStore((s) => s.segments);
  const updateSegment = useAppStore((s) => s.updateSegment);
  const playbackTime = useAppStore((s) => s.playbackTime);
  const seekTick = useAppStore((s) => s.seekTick);
  const requestSeek = useAppStore((s) => s.requestSeek);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const segmentElRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const lastFollowedSegIdRef = useRef<string | null>(null);
  const lastSegId = segments.at(-1)?.id ?? "";
  /** 單一 primitive，避免 useEffect 依賴從 [segments]（長度 1）改成多欄位時在 React 19 觸發「依賴陣列長度變了」錯誤；亦避免逐字編輯時重跑捲動 */
  const segmentListScrollKey = `${segments.length}:${lastSegId}`;
  /** 僅含 id／時間軸，段落文字編輯時不變，供跟隨目前句捲動用 */
  const segmentTimingKey = segments
    .map((s) => `${s.id}:${s.start}:${s.end}`)
    .join("|");

  const hasTranslation = segments.some((s) => Boolean(s.translatedText?.trim()));
  const hasAnySpeaker = segments.some((s) => {
    const t = s.speaker?.trim();
    if (!t) return false;
    return t.toUpperCase() !== "UNKNOWN";
  });

  useEffect(() => {
    if (!followRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [segmentListScrollKey]);

  useEffect(() => {
    if (seekTick > 0) lastFollowedSegIdRef.current = null;
  }, [seekTick]);

  useEffect(() => {
    if (!followRef.current) return;
    const segs = useAppStore.getState().segments;
    if (segs.length === 0) return;
    const active = segs.find((s) =>
      isSegmentActive(playbackTime, s.start, s.end),
    );
    if (!active) return;
    if (active.id === lastFollowedSegIdRef.current) return;
    lastFollowedSegIdRef.current = active.id;
    const el = segmentElRefs.current.get(active.id);
    /** 置中可讀性較佳；若用 nearest 長段落時常只卡住邊緣 */
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [playbackTime, segmentTimingKey]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col border-l border-border bg-card/30">
      <div className="relative z-20 shrink-0 border-b border-border bg-card/30 px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-semibold leading-7">逐字稿</h2>
          <TranscriptHeaderActions />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1 px-2">
        <div className="space-y-1 py-2 pr-3">
          {hasTranslation ?
            <div
              className={cn(
                "grid gap-2 px-3 pb-1 text-xs font-medium text-muted-foreground",
                hasAnySpeaker ? "grid-cols-[auto_1fr_1fr]" : "grid-cols-2",
              )}
            >
              {hasAnySpeaker ? <span className="w-14 shrink-0" /> : null}
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
              /**
               * 依內容自動長高：移除最小高度與 rows，靠 shadcn Textarea 的
               * field-sizing-content 自動貼合單行字；多行時會自然增高。
               */
              const transcriptTextareaClass = cn(
                "min-h-0 resize-none border-transparent bg-transparent py-1 text-sm leading-relaxed shadow-none transition-[color,box-shadow,background-color,border-color]",
                "hover:border-border/80 hover:bg-muted/40",
                "focus-visible:border-input focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/40",
                active ? "text-foreground" : "text-foreground/95",
              );
              const translationTextareaClass = cn(
                transcriptTextareaClass,
                active ? "text-primary/90" : "text-muted-foreground",
              );

              return (
                <div
                  key={seg.id}
                  ref={(el) => {
                    if (el) segmentElRefs.current.set(seg.id, el);
                    else segmentElRefs.current.delete(seg.id);
                  }}
                  className={cn(
                    "flex w-full flex-col gap-1.5 rounded-lg border border-transparent px-3 py-2 text-left text-sm transition-[color,box-shadow,background-color,border-color]",
                    "scroll-my-6 outline-none hover:bg-muted/80",
                    active ?
                      "border-primary/55 bg-primary/15 shadow-[inset_3px_0_0_0_var(--primary)] ring-1 ring-primary/25"
                    : null,
                  )}
                  aria-current={active ? "true" : undefined}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <button
                      type="button"
                      title="自這句開頭播放（行為依下方「點擊時間碼後」選項）"
                      className={cn(
                        "rounded font-mono text-xs underline-offset-2 hover:underline",
                        active ? "font-medium text-primary" : "text-primary/80",
                      )}
                      onClick={() => {
                        if (readTimecodeClickMode() === "segment") {
                          requestSeek(seg.start, {
                            play: true,
                            playUntil: seg.end,
                          });
                        } else {
                          requestSeek(seg.start, { play: true });
                        }
                      }}
                    >
                      {formatTimestamp(seg.start)} — {formatTimestamp(seg.end)}
                    </button>
                    {seg.speaker?.trim() &&
                    seg.speaker.trim().toUpperCase() !== "UNKNOWN" ?
                      <span
                        className={cn(
                          "rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-none",
                          active ?
                            "border-primary/40 bg-primary/10 text-primary"
                          : "border-border bg-muted/60 text-muted-foreground",
                        )}
                      >
                        {seg.speaker.trim()}
                      </span>
                    : null}
                  </div>
                  {hasTranslation ?
                    <div
                      className={cn(
                        "grid gap-3 text-left",
                        hasAnySpeaker ? "grid-cols-[auto_1fr_1fr]" : "grid-cols-2",
                      )}
                    >
                      {hasAnySpeaker ?
                        <span className="w-14 shrink-0" />
                      : null}
                      <Textarea
                        value={seg.text}
                        onChange={(e) =>
                          updateSegment(seg.id, { text: e.target.value })
                        }
                        rows={1}
                        className={transcriptTextareaClass}
                        aria-label="原文"
                      />
                      <Textarea
                        value={seg.translatedText ?? ""}
                        onChange={(e) =>
                          updateSegment(seg.id, {
                            translatedText: e.target.value,
                          })
                        }
                        placeholder="—"
                        rows={1}
                        className={translationTextareaClass}
                        aria-label="譯文"
                      />
                    </div>
                  : <Textarea
                      value={seg.text}
                      onChange={(e) =>
                        updateSegment(seg.id, { text: e.target.value })
                      }
                      rows={1}
                      className={transcriptTextareaClass}
                      aria-label="逐字稿"
                    />}
                </div>
              );
            })
          }
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
      <div className="space-y-2 border-t border-border px-4 py-2">
        <TimecodeClickModeControls />
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
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
    </div>
  );
}
