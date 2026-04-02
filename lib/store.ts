import { create } from "zustand";
import type { AiSummary, TranscriptSegment, TaskItem } from "@/lib/types";

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
  setSegmentTranslations: (updates: { id: string; text: string }[]) => void;

  summary: AiSummary | null;
  setSummary: (s: AiSummary | null) => void;

  playbackTime: number;
  setPlaybackTime: (t: number) => void;

  seekTick: number;
  seekTime: number;
  requestSeek: (t: number) => void;

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
  setMedia: ({ src, path = null, name = null }) =>
    set({ mediaSrc: src, mediaPath: path, mediaName: name }),

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
  clearSegments: () => set({ segments: [] }),
  replaceSegments: (segments) => set({ segments }),
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

  summary: null,
  setSummary: (summary) => set({ summary }),

  playbackTime: 0,
  setPlaybackTime: (playbackTime) => set({ playbackTime }),

  seekTick: 0,
  seekTime: 0,
  requestSeek: (t) =>
    set((s) => ({
      seekTick: s.seekTick + 1,
      seekTime: t,
    })),

  aiBusy: false,
  setAiBusy: (aiBusy) => set({ aiBusy }),
}));
