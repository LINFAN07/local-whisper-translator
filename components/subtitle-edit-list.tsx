"use client";

import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronUp,
  Scissors,
  Trash2,
  Undo2,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { TranscriptHeaderActions } from "@/components/transcript-header-actions";
import { useAppStore } from "@/lib/store";
import { formatTimestamp } from "@/lib/format-time";
import { readTimecodeClickMode } from "@/lib/timecode-click-mode";
import { SUBTITLE_MIN_SEGMENT_SECONDS } from "@/lib/subtitle-segment-constants";
import { cn } from "@/lib/utils";
import { TimecodeClickModeControls } from "@/components/timecode-click-mode-controls";

const SEG_END_EPS = 0.05;

function isSegmentActive(t: number, start: number, end: number) {
  return t >= start && t < end + SEG_END_EPS;
}

export function SubtitleEditList() {
  const segments = useAppStore((s) => s.segments);
  const updateSegment = useAppStore((s) => s.updateSegment);
  const deleteSegment = useAppStore((s) => s.deleteSegment);
  const mergeSegmentWithPrev = useAppStore((s) => s.mergeSegmentWithPrev);
  const mergeSegmentWithNext = useAppStore((s) => s.mergeSegmentWithNext);
  const splitSegmentAtPlayhead = useAppStore((s) => s.splitSegmentAtPlayhead);
  const undoSegmentEdit = useAppStore((s) => s.undoSegmentEdit);
  const canUndo = useAppStore((s) => s.segmentUndoStack.length > 0);
  const playbackTime = useAppStore((s) => s.playbackTime);
  const seekTick = useAppStore((s) => s.seekTick);
  const requestSeek = useAppStore((s) => s.requestSeek);
  const followRef = useRef(true);
  const lastFollowedSegIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastSegId = segments.at(-1)?.id ?? "";
  const segmentListScrollKey = `${segments.length}:${lastSegId}`;
  const segmentTimingKey = segments
    .map((s) => `${s.id}:${s.start}:${s.end}`)
    .join("|");

  const hasTranslation = segments.some((s) => Boolean(s.translatedText?.trim()));
  const hasAnySpeaker = segments.some((s) => {
    const t = s.speaker?.trim();
    if (!t) return false;
    return t.toUpperCase() !== "UNKNOWN";
  });

  const rowVirtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => scrollRef.current,
    /** 初估單行高度；實際以 measureElement 取代 */
    estimateSize: () => (hasTranslation ? 96 : 80),
    overscan: 10,
    getItemKey: (index) => segments[index]?.id ?? index,
  });

  const rowVzRef = useRef(rowVirtualizer);
  rowVzRef.current = rowVirtualizer;

  useEffect(() => {
    if (!followRef.current) return;
    if (segments.length === 0) return;
    rowVzRef.current.scrollToIndex(segments.length - 1, {
      align: "end",
      behavior: "smooth",
    });
  }, [segmentListScrollKey, segments.length]);

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
    const idx = segs.findIndex((s) => s.id === active.id);
    if (idx >= 0) {
      rowVzRef.current.scrollToIndex(idx, {
        align: "center",
        behavior: "smooth",
      });
    }
  }, [playbackTime, segmentTimingKey]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-card/30">
      <div className="relative z-20 shrink-0 border-b border-border bg-card/30 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold leading-7">字幕與翻譯</h2>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="gap-1"
              disabled={!canUndo}
              title="復原上一筆字幕編輯（時間軸拖曳，或刪除／合併／拆分）。快捷鍵：Ctrl+Z（macOS：⌘Z）；在輸入框內不觸發。"
              onClick={() => undoSegmentEdit()}
            >
              <Undo2 className="size-3.5" aria-hidden />
              復原上一步
            </Button>
          </div>
          <TranscriptHeaderActions />
        </div>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2"
      >
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
              請先在「轉錄」工作區匯入媒體並完成轉錄，或從左側歷史載入紀錄。
            </p>
          : <div
              className="relative w-full"
              style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
              {rowVirtualizer.getVirtualItems().map((vi) => {
                const index = vi.index;
                const seg = segments[index]!;
                const active = isSegmentActive(
                  playbackTime,
                  seg.start,
                  seg.end,
                );
                const splitLo = seg.start + SUBTITLE_MIN_SEGMENT_SECONDS;
                const splitHi = seg.end - SUBTITLE_MIN_SEGMENT_SECONDS;
                const canSplitAtPlayhead =
                  active &&
                  playbackTime > splitLo &&
                  playbackTime < splitHi;
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
                    key={vi.key}
                    data-index={vi.index}
                    ref={rowVirtualizer.measureElement}
                    className="absolute left-0 w-full pb-1"
                    style={{ transform: `translateY(${vi.start}px)` }}
                  >
                    <div
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
                            active ?
                              "font-medium text-primary"
                            : "text-primary/80",
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
                          {formatTimestamp(seg.start)} —{" "}
                          {formatTimestamp(seg.end)}
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
                        <span className="ml-auto flex shrink-0 flex-wrap items-center gap-0.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground hover:text-foreground"
                            title="與上一句合併（時間接為一句，文字以空格相接）"
                            disabled={index === 0}
                            aria-label="與上一句合併"
                            onClick={() => {
                              mergeSegmentWithPrev(seg.id);
                            }}
                          >
                            <ChevronUp className="size-3.5" aria-hidden />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground hover:text-foreground"
                            title="與下一句合併"
                            disabled={index >= segments.length - 1}
                            aria-label="與下一句合併"
                            onClick={() => {
                              mergeSegmentWithNext(seg.id);
                            }}
                          >
                            <ChevronDown className="size-3.5" aria-hidden />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground hover:text-foreground"
                            title={
                              canSplitAtPlayhead ?
                                "於播放頭拆成兩句（後段文字為空，請自行貼上）"
                              : "請將時間軸橘線移入本句區間內（須距起訖至少 0.08 秒）"
                            }
                            disabled={!canSplitAtPlayhead}
                            aria-label="於播放頭拆分"
                            onClick={() => {
                              const ok = splitSegmentAtPlayhead(seg.id);
                              if (!ok) {
                                alert(
                                  "無法拆分：請暫停或播放，讓橘色播放頭落在此句起訖之間，且與起訖至少相隔 0.08 秒。",
                                );
                              }
                            }}
                          >
                            <Scissors className="size-3.5" aria-hidden />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
                            title="刪除此句"
                            aria-label="刪除此句"
                            onClick={() => {
                              if (
                                !confirm(
                                  "確定要刪除這句字幕嗎？此操作無法復原（未另存前可關閉不重存）。",
                                )
                              )
                                return;
                              deleteSegment(seg.id);
                            }}
                          >
                            <Trash2 className="size-3.5" aria-hidden />
                          </Button>
                        </span>
                      </div>
                      {hasTranslation ?
                        <div
                          className={cn(
                            "grid gap-3 text-left",
                            hasAnySpeaker ?
                              "grid-cols-[auto_1fr_1fr]"
                            : "grid-cols-2",
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
                          aria-label="字幕"
                        />}
                    </div>
                  </div>
                );
              })}
            </div>
          }
        </div>
      </div>
      <div className="space-y-2 border-t border-border px-4 py-2">
        <p className="text-xs leading-relaxed text-muted-foreground">
          同一段時間碼內要分兩行顯示時，於原文或譯文框按{" "}
          <kbd className="rounded border border-border bg-muted px-1 py-px font-mono text-[10px]">
            Shift+Enter
          </kbd>{" "}
          或{" "}
          <kbd className="rounded border border-border bg-muted px-1 py-px font-mono text-[10px]">
            Enter
          </kbd>{" "}
          換行。
        </p>
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
