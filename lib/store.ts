import { create } from "zustand";
import type { AiSummary, TranscriptSegment, TaskItem } from "@/lib/types";

const MAX_SEGMENT_TIMING_UNDO = 80;

export type SegmentTimingUndoEntry = {
  id: string;
  start: number;
  end: number;
};

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

  /** 時間軸拖曳調整起訖後可復原（與文字編輯分開） */
  segmentTimingUndoStack: SegmentTimingUndoEntry[];
  pushSegmentTimingUndo: (entry: SegmentTimingUndoEntry) => void;
  /** 復原最近一次時間軸調整；若對應句段已不存在則僅彈出該筆紀錄 */
  undoSegmentTiming: () => boolean;

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
}

export const useAppStore = create<AppState>((set) => ({
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
      segmentTimingUndoStack: [],
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
          id: `seg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        },
      ],
    })),
  clearSegments: () =>
    set({ segments: [], playbackStopAt: null, segmentTimingUndoStack: [] }),
  replaceSegments: (segments) =>
    set({ segments, playbackStopAt: null, segmentTimingUndoStack: [] }),
  segmentTimingUndoStack: [],
  pushSegmentTimingUndo: (entry) =>
    set((s) => ({
      segmentTimingUndoStack: [
        ...s.segmentTimingUndoStack,
        entry,
      ].slice(-MAX_SEGMENT_TIMING_UNDO),
    })),
  undoSegmentTiming: () => {
    let applied = false;
    set((s) => {
      if (s.segmentTimingUndoStack.length === 0) return s;
      const snap = s.segmentTimingUndoStack[s.segmentTimingUndoStack.length - 1]!;
      const stack = s.segmentTimingUndoStack.slice(0, -1);
      const seg = s.segments.find((x) => x.id === snap.id);
      if (!seg) return { segmentTimingUndoStack: stack };
      applied = true;
      return {
        segmentTimingUndoStack: stack,
        segments: s.segments.map((x) =>
          x.id === snap.id ? { ...x, start: snap.start, end: snap.end } : x,
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

  setMediaDuration: (mediaDuration) => set({ mediaDuration }),
}));
