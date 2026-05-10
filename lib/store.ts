import { create } from "zustand";
import type { AiSummary, TranscriptSegment, TaskItem } from "@/lib/types";
import { SUBTITLE_MIN_SEGMENT_SECONDS } from "@/lib/subtitle-segment-constants";

const MAX_SEGMENT_UNDO = 80;

function cloneSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments.map((s) => ({ ...s }));
}

function newSegmentId(): string {
  return `seg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function joinSegmentText(a: string, b: string): string {
  const ta = a.trim();
  const tb = b.trim();
  if (!ta) return b;
  if (!tb) return a;
  return `${ta} ${tb}`;
}

function mergeSpeaker(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  const sa = a?.trim() ?? "";
  const sb = b?.trim() ?? "";
  if (!sa || !sb) return null;
  if (sa.toUpperCase() === "UNKNOWN" || sb.toUpperCase() === "UNKNOWN")
    return null;
  if (sa === sb) return sa;
  return null;
}

export type SegmentTimingUndoEntry = {
  id: string;
  start: number;
  end: number;
};

export type SegmentUndoEntry =
  | ({ type: "timing" } & SegmentTimingUndoEntry)
  | { type: "structure"; segments: TranscriptSegment[] };

interface AppState {
  tasks: TaskItem[];
  setTasks: (tasks: TaskItem[]) => void;
  addTask: (name: string) => void;

  currentTaskId: string | null;
  setCurrentTaskId: (id: string | null) => void;
  /** 從資料庫載入時保留建立時間；本機新作時為 null 直到首次儲存 */
  taskCreatedAt: number | null;
  setTaskCreatedAt: (n: number | null) => void;

  mediaSrc: string | null;
  mediaPath: string | null;
  mediaName: string | null;
  setMedia: (opts: {
    src: string | null;
    path?: string | null;
    name?: string | null;
  }) => void;

  progress: number;
  status: "idle" | "processing" | "done" | "error";
  statusMessage: string;
  setProgress: (v: number, message?: string) => void;
  setStatus: (s: AppState["status"], message?: string) => void;

  segments: TranscriptSegment[];
  appendSegment: (s: Omit<TranscriptSegment, "id">) => void;
  clearSegments: () => void;
  replaceSegments: (segments: TranscriptSegment[]) => void;
  updateSegment: (
    id: string,
    patch: Partial<
      Pick<TranscriptSegment, "text" | "translatedText" | "start" | "end">
    >,
  ) => void;

  deleteSegment: (id: string) => void;
  mergeSegmentWithNext: (id: string) => boolean;
  mergeSegmentWithPrev: (id: string) => boolean;
  /** 以目前播放頭為切點；成功為 true，播放頭須落在句內有效區間 */
  splitSegmentAtPlayhead: (id: string) => boolean;

  /** 時間軸拖曳與刪除／合併／拆分等結構變更，依操作順序 LIFO 復原 */
  segmentUndoStack: SegmentUndoEntry[];
  pushSegmentTimingUndo: (entry: SegmentTimingUndoEntry) => void;
  /** 復原上一筆（時間軸或字幕結構）；若時間軸目標句已刪則僅彈出該筆 */
  undoSegmentEdit: () => boolean;

  mediaDuration: number | null;
  setMediaDuration: (seconds: number | null) => void;
  setSegmentTranslations: (updates: { id: string; text: string }[]) => void;
  setSegmentSpeakers: (updates: { id: string; speaker: string | null }[]) => void;
  clearAllSpeakers: () => void;

  summary: AiSummary | null;
  setSummary: (s: AiSummary | null) => void;

  playbackTime: number;
  setPlaybackTime: (t: number) => void;

  seekTick: number;
  seekTime: number;
  /** 與 seek 配對：僅在需要時遞增，供 MediaPlayer 在跳轉後呼叫 play()；處理完應歸零以免換頁重掛時誤播 */
  playAfterSeekTick: number;
  clearPlayAfterSeek: () => void;
  /** 若為數字，播放到該秒數時自動暫停（點時間碼「只播該句」）；一般 seek 會清除 */
  playbackStopAt: number | null;
  clearPlaybackStopAt: () => void;
  requestSeek: (t: number, opts?: { play?: boolean; playUntil?: number }) => void;

  aiBusy: boolean;
  setAiBusy: (v: boolean) => void;

  /** 說話人識別（pyannote）跨面板共用；兩處 TranscriptHeaderActions 共用同一份狀態 */
  speakerAssignBusy: boolean;
  speakerAssignStartedAt: number | null;
  speakerAssignLog: string;
  /** 僅用於驅動 UI 週期重繪（與 startedAt 搭配顯示經過時間） */
  speakerAssignUiTick: number;
  startSpeakerAssignSession: () => void;
  endSpeakerAssignSession: () => void;
  applySpeakerAssignIpc: (p: {
    kind: "start" | "log" | "end";
    text?: string;
  }) => void;
}

let speakerAssignIpcUnsub: (() => void) | null = null;
let speakerAssignTickTimer: ReturnType<typeof setInterval> | null = null;

function ensureSpeakerAssignIpc() {
  if (typeof window === "undefined") return;
  if (speakerAssignIpcUnsub) return;
  const api = window.electronAPI;
  if (!api?.onSpeakerAssignProgress) return;
  speakerAssignIpcUnsub = api.onSpeakerAssignProgress((p) => {
    useAppStore.getState().applySpeakerAssignIpc(p);
  });
}

function startSpeakerAssignUiTicker() {
  if (speakerAssignTickTimer != null) return;
  speakerAssignTickTimer = setInterval(() => {
    useAppStore.setState((s) => ({
      speakerAssignUiTick: s.speakerAssignUiTick + 1,
    }));
  }, 250);
}

function stopSpeakerAssignUiTicker() {
  if (speakerAssignTickTimer != null) {
    clearInterval(speakerAssignTickTimer);
    speakerAssignTickTimer = null;
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  tasks: [],
  setTasks: (tasks) => set({ tasks }),
  addTask: (name) =>
    set((s) => ({
      tasks: [
        {
          id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          name,
          createdAt: Date.now(),
        },
        ...s.tasks,
      ],
    })),

  currentTaskId: null,
  setCurrentTaskId: (currentTaskId) => set({ currentTaskId }),
  taskCreatedAt: null,
  setTaskCreatedAt: (taskCreatedAt) => set({ taskCreatedAt }),

  mediaSrc: null,
  mediaPath: null,
  mediaName: null,
  mediaDuration: null,
  setMedia: ({ src, path = null, name = null }) =>
    set({
      mediaSrc: src,
      mediaPath: path,
      mediaName: name,
      mediaDuration: null,
      playbackStopAt: null,
      segmentUndoStack: [],
    }),

  progress: 0,
  status: "idle",
  statusMessage: "",
  setProgress: (progress, statusMessage = "") =>
    set({ progress, statusMessage }),
  setStatus: (status, statusMessage = "") => set({ status, statusMessage }),

  segments: [],
  appendSegment: (seg) =>
    set((s) => ({
      segments: [
        ...s.segments,
        {
          ...seg,
          id: newSegmentId(),
        },
      ],
    })),
  clearSegments: () =>
    set({ segments: [], playbackStopAt: null, segmentUndoStack: [] }),
  replaceSegments: (segments) =>
    set({ segments, playbackStopAt: null, segmentUndoStack: [] }),
  segmentUndoStack: [],
  pushSegmentTimingUndo: (entry) =>
    set((s) => ({
      segmentUndoStack: [
        ...s.segmentUndoStack,
        { type: "timing" as const, ...entry },
      ].slice(-MAX_SEGMENT_UNDO),
    })),
  undoSegmentEdit: () => {
    let applied = false;
    set((s) => {
      if (s.segmentUndoStack.length === 0) return s;
      const top = s.segmentUndoStack[s.segmentUndoStack.length - 1]!;
      const stack = s.segmentUndoStack.slice(0, -1);
      if (top.type === "structure") {
        applied = true;
        return {
          segmentUndoStack: stack,
          segments: cloneSegments(top.segments),
          playbackStopAt: null,
        };
      }
      const seg = s.segments.find((x) => x.id === top.id);
      if (!seg) return { segmentUndoStack: stack };
      applied = true;
      return {
        segmentUndoStack: stack,
        segments: s.segments.map((x) =>
          x.id === top.id ? { ...x, start: top.start, end: top.end } : x,
        ),
      };
    });
    return applied;
  },
  updateSegment: (id, patch) =>
    set((s) => ({
      segments: s.segments.map((seg) =>
        seg.id === id ? { ...seg, ...patch } : seg,
      ),
    })),

  deleteSegment: (id) =>
    set((s) => ({
      segmentUndoStack: [
        ...s.segmentUndoStack,
        { type: "structure" as const, segments: cloneSegments(s.segments) },
      ].slice(-MAX_SEGMENT_UNDO),
      segments: s.segments.filter((seg) => seg.id !== id),
      playbackStopAt: null,
    })),

  mergeSegmentWithNext: (id) => {
    const s = get();
    const i = s.segments.findIndex((x) => x.id === id);
    if (i < 0 || i >= s.segments.length - 1) return false;
    const a = s.segments[i]!;
    const b = s.segments[i + 1]!;
    const merged: TranscriptSegment = {
      id: newSegmentId(),
      start: a.start,
      end: b.end,
      text: joinSegmentText(a.text, b.text),
      translatedText: joinSegmentText(
        a.translatedText ?? "",
        b.translatedText ?? "",
      ),
      speaker: mergeSpeaker(a.speaker, b.speaker),
    };
    if (!merged.translatedText?.trim()) merged.translatedText = null;
    set({
      segmentUndoStack: [
        ...s.segmentUndoStack,
        { type: "structure" as const, segments: cloneSegments(s.segments) },
      ].slice(-MAX_SEGMENT_UNDO),
      segments: [...s.segments.slice(0, i), merged, ...s.segments.slice(i + 2)],
      playbackStopAt: null,
    });
    return true;
  },

  mergeSegmentWithPrev: (id) => {
    const s = get();
    const i = s.segments.findIndex((x) => x.id === id);
    if (i <= 0) return false;
    const a = s.segments[i - 1]!;
    const b = s.segments[i]!;
    const merged: TranscriptSegment = {
      id: newSegmentId(),
      start: a.start,
      end: b.end,
      text: joinSegmentText(a.text, b.text),
      translatedText: joinSegmentText(
        a.translatedText ?? "",
        b.translatedText ?? "",
      ),
      speaker: mergeSpeaker(a.speaker, b.speaker),
    };
    if (!merged.translatedText?.trim()) merged.translatedText = null;
    set({
      segmentUndoStack: [
        ...s.segmentUndoStack,
        { type: "structure" as const, segments: cloneSegments(s.segments) },
      ].slice(-MAX_SEGMENT_UNDO),
      segments: [
        ...s.segments.slice(0, i - 1),
        merged,
        ...s.segments.slice(i + 1),
      ],
      playbackStopAt: null,
    });
    return true;
  },

  splitSegmentAtPlayhead: (id) => {
    const s = get();
    const i = s.segments.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const seg = s.segments[i]!;
    const t = s.playbackTime;
    const lo = seg.start + SUBTITLE_MIN_SEGMENT_SECONDS;
    const hi = seg.end - SUBTITLE_MIN_SEGMENT_SECONDS;
    if (!(t > lo && t < hi)) return false;
    const sp = seg.speaker;
    const first: TranscriptSegment = {
      id: newSegmentId(),
      start: seg.start,
      end: t,
      text: seg.text,
      translatedText: seg.translatedText ?? null,
      speaker: sp,
    };
    const second: TranscriptSegment = {
      id: newSegmentId(),
      start: t,
      end: seg.end,
      text: "",
      translatedText: null,
      speaker: sp,
    };
    set({
      segmentUndoStack: [
        ...s.segmentUndoStack,
        { type: "structure" as const, segments: cloneSegments(s.segments) },
      ].slice(-MAX_SEGMENT_UNDO),
      segments: [
        ...s.segments.slice(0, i),
        first,
        second,
        ...s.segments.slice(i + 1),
      ],
      playbackStopAt: null,
    });
    return true;
  },

  setSegmentTranslations: (updates) =>
    set((s) => {
      const map = new Map(updates.map((u) => [u.id, u.text]));
      return {
        segments: s.segments.map((seg) => {
          const t = map.get(seg.id);
          if (t === undefined) return seg;
          return { ...seg, translatedText: t };
        }),
      };
    }),
  setSegmentSpeakers: (updates) =>
    set((s) => {
      const map = new Map(updates.map((u) => [u.id, u.speaker]));
      return {
        segments: s.segments.map((seg) => {
          const sp = map.get(seg.id);
          if (sp === undefined) return seg;
          return { ...seg, speaker: sp };
        }),
      };
    }),
  clearAllSpeakers: () =>
    set((s) => ({
      segments: s.segments.map((seg) => ({ ...seg, speaker: null })),
    })),

  summary: null,
  setSummary: (summary) => set({ summary }),

  playbackTime: 0,
  setPlaybackTime: (playbackTime) => set({ playbackTime }),

  seekTick: 0,
  seekTime: 0,
  playAfterSeekTick: 0,
  clearPlayAfterSeek: () => set({ playAfterSeekTick: 0 }),
  playbackStopAt: null,
  clearPlaybackStopAt: () => set({ playbackStopAt: null }),
  requestSeek: (t, opts) =>
    set((s) => {
      const playUntil =
        typeof opts?.playUntil === "number" && Number.isFinite(opts.playUntil) ?
          opts.playUntil
        : null;
      return {
        seekTick: s.seekTick + 1,
        seekTime: t,
        playAfterSeekTick:
          opts?.play ? s.playAfterSeekTick + 1 : s.playAfterSeekTick,
        playbackStopAt: playUntil,
      };
    }),

  aiBusy: false,
  setAiBusy: (aiBusy) => set({ aiBusy }),

  speakerAssignBusy: false,
  speakerAssignStartedAt: null,
  speakerAssignLog: "",
  speakerAssignUiTick: 0,
  startSpeakerAssignSession: () => {
    ensureSpeakerAssignIpc();
    startSpeakerAssignUiTicker();
    set({
      speakerAssignBusy: true,
      speakerAssignStartedAt: Date.now(),
      speakerAssignLog: "",
      speakerAssignUiTick: 0,
    });
  },
  endSpeakerAssignSession: () => {
    stopSpeakerAssignUiTicker();
    set({
      speakerAssignBusy: false,
      speakerAssignStartedAt: null,
      speakerAssignLog: "",
    });
  },
  applySpeakerAssignIpc: (p) => {
    if (p.kind === "start") set({ speakerAssignLog: "" });
    else if (p.kind === "log" && typeof p.text === "string") {
      set({ speakerAssignLog: p.text });
    }
  },

  setMediaDuration: (mediaDuration) => set({ mediaDuration }),
}));
