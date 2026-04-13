"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "@/lib/store";
import type { TranscriptSegment } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MIN_SEG = 0.08;
const EDGE_PX = 8;
/** 固定時間軸比例（px/秒），不提供使用者調整以避免版面漂移 */
const FIXED_PX_PER_SEC = 56;
const WAVEFORM_DECODE_BARS = 2000;
/** 波形區高度（px），與上下字幕軌視覺比例協調 */
const WAVE_HEIGHT_PX = 72;

function computePeaks(buffer: AudioBuffer, barCount: number): Float32Array {
  const ch = buffer.getChannelData(0);
  const len = ch.length;
  const block = Math.max(1, Math.floor(len / barCount));
  const peaks = new Float32Array(barCount);
  for (let i = 0; i < barCount; i++) {
    let sum = 0;
    const start = i * block;
    const end = Math.min(start + block, len);
    for (let j = start; j < end; j++) {
      sum += Math.abs(ch[j] ?? 0);
    }
    peaks[i] = sum / (end - start);
  }
  let max = 1e-9;
  for (let i = 0; i < barCount; i++) {
    if (peaks[i] > max) max = peaks[i];
  }
  for (let i = 0; i < barCount; i++) peaks[i] /= max;
  return peaks;
}

function clampSegment(
  start: number,
  end: number,
  duration: number,
): { start: number; end: number } {
  let s = Math.max(0, start);
  let e = Math.min(duration, end);
  if (e - s < MIN_SEG) {
    if (s + MIN_SEG <= duration) e = s + MIN_SEG;
    else {
      e = duration;
      s = Math.max(0, e - MIN_SEG);
    }
  }
  return { start: s, end: e };
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const t = target.tagName;
  return t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
}

export function SubtitleTimeline() {
  const segments = useAppStore((s) => s.segments);
  const mediaSrc = useAppStore((s) => s.mediaSrc);
  const mediaPath = useAppStore((s) => s.mediaPath);
  const mediaDuration = useAppStore((s) => s.mediaDuration);
  const playbackTime = useAppStore((s) => s.playbackTime);
  const requestSeek = useAppStore((s) => s.requestSeek);
  const updateSegment = useAppStore((s) => s.updateSegment);
  const pushSegmentTimingUndo = useAppStore((s) => s.pushSegmentTimingUndo);
  const undoSegmentTiming = useAppStore((s) => s.undoSegmentTiming);
  const canUndoTiming = useAppStore((s) => s.segmentTimingUndoStack.length > 0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
  const [viewportW, setViewportW] = useState(640);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [waveError, setWaveError] = useState(false);
  const [waveLoading, setWaveLoading] = useState(false);

  const maxEnd = segments.reduce((m, s) => Math.max(m, s.end), 0);
  const duration = Math.max(
    1,
    mediaDuration && mediaDuration > 0 ? mediaDuration : maxEnd > 0 ? maxEnd : 1,
  );

  const hasTranslation = segments.some((s) => Boolean(s.translatedText?.trim()));

  /** 時間軸至少與視窗同寬，並依「秒數 × 每秒像素」延展，避免大量句段擠成細線 */
  const timelineWidthPx = Math.max(viewportW, duration * FIXED_PX_PER_SEC);

  const [preview, setPreview] = useState<{
    id: string;
    start: number;
    end: number;
  } | null>(null);

  const segDisplay = useCallback(
    (seg: TranscriptSegment) => {
      if (preview && preview.id === seg.id) {
        return { start: preview.start, end: preview.end };
      }
      return { start: seg.start, end: seg.end };
    },
    [preview],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewportW(el.clientWidth || 1);
    });
    ro.observe(el);
    setViewportW(el.clientWidth || 1);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "z" || e.shiftKey) return;
      if (isEditableKeyboardTarget(e.target)) return;
      if (useAppStore.getState().segmentTimingUndoStack.length === 0) return;
      e.preventDefault();
      useAppStore.getState().undoSegmentTiming();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!mediaSrc) {
      setPeaks(null);
      setWaveError(false);
      setWaveLoading(false);
      return;
    }
    let cancelled = false;
    setWaveError(false);
    setWaveLoading(true);
    setPeaks(null);

    const toArrayBuffer = (data: ArrayBuffer | Uint8Array): ArrayBuffer => {
      if (data instanceof ArrayBuffer) return data.slice(0);
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    };

    (async () => {
      try {
        let buf: ArrayBuffer | null = null;
        const localPath = mediaPath?.trim();
        if (localPath && window.electronAPI?.readMediaFile) {
          const bytes = await window.electronAPI.readMediaFile(localPath);
          if (cancelled) return;
          if (bytes && bytes.byteLength > 0) buf = toArrayBuffer(bytes);
        }
        if (!buf) {
          const res = await fetch(mediaSrc);
          if (cancelled) return;
          if (!res.ok) throw new Error(`fetch ${res.status}`);
          buf = await res.arrayBuffer();
        }
        if (cancelled) return;
        if (!buf.byteLength) throw new Error("empty");

        const ctx = new AudioContext();
        let audio: AudioBuffer;
        try {
          audio = await ctx.decodeAudioData(buf.slice(0));
        } finally {
          await ctx.close().catch(() => {});
        }
        if (cancelled) return;
        setPeaks(computePeaks(audio, WAVEFORM_DECODE_BARS));
        setWaveError(false);
      } catch {
        if (!cancelled) {
          setPeaks(null);
          setWaveError(true);
        }
      } finally {
        if (!cancelled) setWaveLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mediaSrc, mediaPath]);

  useEffect(() => {
    const canvas = waveCanvasRef.current;
    if (!canvas) return;
    const w = timelineWidthPx;
    const h = WAVE_HEIGHT_PX;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    /** 白底、中央對稱淡灰波形，貼近常見字幕／對軸編輯畫面 */
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(0, 0, 0, 0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    if (peaks && peaks.length > 0) {
      const barW = w / peaks.length;
      const maxHalf = h / 2 - 6;
      ctx.fillStyle = "#9ca3af";
      for (let i = 0; i < peaks.length; i++) {
        const half = peaks[i] * maxHalf;
        const x = i * barW;
        const bw = Math.max(1, barW - 0.35);
        ctx.fillRect(x, h / 2 - half, bw, half * 2);
      }
    } else if (waveError) {
      ctx.fillStyle = "#71717a";
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText("無法產生波形（可仍可使用時間軸）", 10, h / 2 + 4);
    } else if (waveLoading) {
      ctx.fillStyle = "#a1a1aa";
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText("載入波形…", 10, h / 2 + 4);
    }
  }, [peaks, timelineWidthPx, waveError, waveLoading]);

  /** 以時間軸內容區（可捲動寬度）換算時間 */
  const timeFromClientX = useCallback(
    (clientX: number) => {
      const el = contentRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left;
      const tw = rect.width;
      const t = (x / tw) * duration;
      return Math.max(0, Math.min(duration, t));
    },
    [duration],
  );

  const onTrackPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-sub-block]")) return;
    if ((e.target as HTMLElement).closest("[data-playhead-handle]")) return;
    requestSeek(timeFromClientX(e.clientX));
  };

  const onPlayheadPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      setIsDraggingPlayhead(true);
      requestSeek(timeFromClientX(e.clientX));

      const onMove = (ev: PointerEvent) => {
        requestSeek(timeFromClientX(ev.clientX));
      };
      const onUp = (ev: PointerEvent) => {
        setIsDraggingPlayhead(false);
        try {
          el.releasePointerCapture(ev.pointerId);
        } catch {
          /* 已釋放或非本元素 capture */
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [requestSeek, timeFromClientX],
  );

  const onBlockPointerDown = (
    e: React.PointerEvent,
    seg: TranscriptSegment,
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const bw = rect.width;
    let mode: "move" | "resize-start" | "resize-end" = "move";
    if (bw >= 24) {
      if (x < EDGE_PX) mode = "resize-start";
      else if (x > bw - EDGE_PX) mode = "resize-end";
    }
    const { start: origStart, end: origEnd } = segDisplay(seg);
    const pointerStartX = e.clientX;
    const id = seg.id;
    let lastStart = origStart;
    let lastEnd = origEnd;

    const onMove = (ev: PointerEvent) => {
      const el = contentRef.current;
      const tw = el?.getBoundingClientRect().width || timelineWidthPx;
      const dx = ev.clientX - pointerStartX;
      const dt = (dx / tw) * duration;
      let ns = origStart;
      let ne = origEnd;
      if (mode === "move") {
        ns = origStart + dt;
        ne = origEnd + dt;
      } else if (mode === "resize-start") {
        ns = origStart + dt;
        ne = origEnd;
      } else {
        ns = origStart;
        ne = origEnd + dt;
      }
      const c = clampSegment(ns, ne, duration);
      lastStart = c.start;
      lastEnd = c.end;
      setPreview({ id, start: c.start, end: c.end });
    };

    const onUp = () => {
      const changed =
        Math.abs(lastStart - origStart) > 1e-5 ||
        Math.abs(lastEnd - origEnd) > 1e-5;
      if (changed) {
        pushSegmentTimingUndo({ id, start: origStart, end: origEnd });
        updateSegment(id, { start: lastStart, end: lastEnd });
      }
      setPreview(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    setPreview({ id, start: origStart, end: origEnd });
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const playheadPct = (playbackTime / duration) * 100;

  /** 目前播放時間落在哪一句（原文軌高亮用） */
  const activeSourceSegId =
    segments.find((s) => playbackTime >= s.start && playbackTime < s.end)?.id ??
    null;

  /** 播放頭捲入可視區（拖曳橘線時不捲動，避免與操作打架） */
  useEffect(() => {
    if (isDraggingPlayhead) return;
    const sc = scrollRef.current;
    if (!sc || !contentRef.current) return;
    const x = (playbackTime / duration) * timelineWidthPx;
    const pad = 80;
    const left = sc.scrollLeft;
    const vw = sc.clientWidth;
    if (x < left + pad) {
      sc.scrollLeft = Math.max(0, x - pad);
    } else if (x > left + vw - pad) {
      sc.scrollLeft = Math.max(0, x - vw + pad);
    }
  }, [playbackTime, duration, timelineWidthPx, isDraggingPlayhead]);

  const renderTrackBlocks = (
    label: string,
    pickText: (s: TranscriptSegment) => string,
    muted: boolean,
    activeSegId: string | null,
  ) => (
    <div
      className="relative min-h-[2.75rem] border-b border-zinc-200/90 bg-white last:border-b-0"
    >
      {segments.map((seg) => {
        const { start, end } = segDisplay(seg);
        const left = (start / duration) * 100;
        const widthPct = ((end - start) / duration) * 100;
        const text = pickText(seg).trim() || "（空）";
        const isActive = !muted && activeSegId === seg.id;
        return (
          <button
            key={`${label}-${seg.id}`}
            type="button"
            data-sub-block
            className={cn(
              "absolute top-1 bottom-1 overflow-hidden rounded-md border px-1.5 py-0.5 text-left text-[11px] leading-snug shadow-sm",
              "touch-none select-none",
              muted ?
                "border-zinc-200/90 bg-white text-zinc-700 hover:bg-zinc-50/90"
              : isActive ?
                "border-orange-200/70 bg-orange-50 text-zinc-900 hover:bg-orange-100/90"
              : "border-zinc-200/90 bg-white text-zinc-800 hover:bg-zinc-50/90",
            )}
            style={{
              left: `${left}%`,
              width: `${widthPct}%`,
            }}
            title={`${start.toFixed(2)}s — ${end.toFixed(2)}s · ${text.slice(0, 120)}`}
            onPointerDown={(e) => onBlockPointerDown(e, seg)}
          >
            <span className="line-clamp-3 break-words">{text}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="flex min-h-0 w-full flex-col gap-2">
      <div className="flex flex-col gap-2 px-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">時間軸</h3>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!canUndoTiming}
              title="復原上一次在時間軸上拖曳調整的起訖時間。快捷鍵：Ctrl+Z（macOS：⌘Z）；在輸入框內時不會觸發，以免影響文字復原。"
              onClick={() => undoSegmentTiming()}
            >
              復原上一步
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            橘線為播放頭，可左右拖曳調整播放位置；亦可捲動時間軸、點波形跳轉。橫向比例已固定。
          </p>
        </div>
      </div>
      <div className="flex overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex w-[7.5rem] shrink-0 flex-col border-r border-zinc-200 bg-zinc-100">
          <div
            className="flex items-end border-b border-zinc-200 px-2 pb-1 text-[10px] font-medium text-zinc-500"
            style={{ minHeight: WAVE_HEIGHT_PX }}
          >
            波形
          </div>
          <div className="flex min-h-[2.75rem] items-center border-b border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-700">
            原文
          </div>
          {hasTranslation ?
            <div className="flex min-h-[2.75rem] items-center px-2 py-1 text-xs font-medium text-zinc-500">
              譯文
            </div>
          : null}
        </div>
        <div
          ref={scrollRef}
          className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden bg-white"
        >
          <div
            ref={contentRef}
            className="relative"
            style={{ width: timelineWidthPx, minWidth: "100%" }}
          >
            <div
              className="relative z-[2] shrink-0 overflow-hidden bg-white"
              style={{ height: WAVE_HEIGHT_PX }}
            >
              <canvas
                ref={waveCanvasRef}
                className="block h-full w-full cursor-pointer"
                onPointerDown={onTrackPointerDown}
                role="presentation"
              />
            </div>
            <div className="relative z-[1] border-t border-zinc-100">
              {renderTrackBlocks("原文", (s) => s.text, false, activeSourceSegId)}
              {hasTranslation ?
                renderTrackBlocks(
                  "譯文",
                  (s) => s.translatedText ?? "",
                  true,
                  null,
                )
              : null}
            </div>
            {/* 橘色播放頭：寬版命中區可拖曳 seek；內層維持細線視覺 */}
            <div className="pointer-events-none absolute inset-0 z-30">
              <div
                data-playhead-handle
                className="pointer-events-auto absolute top-0 bottom-0 flex w-3 -translate-x-1/2 cursor-ew-resize touch-none select-none items-stretch justify-center"
                style={{ left: `${playheadPct}%` }}
                onPointerDown={onPlayheadPointerDown}
                role="slider"
                tabIndex={0}
                aria-label="播放頭，左右拖曳調整播放位置"
                aria-valuemin={0}
                aria-valuemax={Math.round(duration * 1000) / 1000}
                aria-valuenow={Math.round(playbackTime * 1000) / 1000}
                onKeyDown={(e) => {
                  const step = Math.max(0.05, duration / 200);
                  if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    requestSeek(Math.max(0, playbackTime - step));
                  } else if (e.key === "ArrowRight") {
                    e.preventDefault();
                    requestSeek(Math.min(duration, playbackTime + step));
                  }
                }}
              >
                <div
                  className="pointer-events-none w-0.5 shrink-0 bg-orange-500 shadow-[0_0_0_1px_rgba(255,255,255,0.85),0_0_6px_rgba(249,115,22,0.45)]"
                  aria-hidden
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
