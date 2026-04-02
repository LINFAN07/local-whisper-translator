import type { TranscriptEvent, TranscriptSegment, AiSummary } from "@/lib/types";

export interface DbTaskRow {
  id: string;
  name: string;
  mediaPath: string | null;
  mediaName: string | null;
  summaryJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DbTaskPayload {
  task: {
    id: string;
    name: string;
    mediaPath?: string | null;
    mediaName?: string | null;
    summaryJson?: string | AiSummary | null;
    createdAt?: number;
  };
  segments: TranscriptSegment[];
}

export interface ElectronAPI {
  getPathForFile: (file: File) => string;
  getFileUrl: (filePath: string) => Promise<string | null>;
  openFileDialog: () => Promise<string | null>;
  /** 本機檔案路徑，或 http(s) 連結（由 Python 以 yt-dlp 下載後轉錄） */
  transcribeStart: (filePathOrUrl: string) => Promise<{ ok: boolean; error?: string }>;
  transcribeCancel: () => Promise<{ ok: boolean }>;
  onTranscribeEvent: (cb: (payload: TranscriptEvent) => void) => () => void;

  settingsGet: () => Promise<Record<string, unknown>>;
  settingsSet: (partial: Record<string, unknown>) => Promise<{ ok: boolean }>;

  dbListTasks: () => Promise<DbTaskRow[]>;
  dbGetTask: (
    taskId: string,
  ) => Promise<{
    task: DbTaskRow;
    segments: TranscriptSegment[];
  } | null>;
  dbSaveTask: (
    payload: DbTaskPayload,
  ) => Promise<{ ok: boolean; error?: string }>;
  dbDeleteTask: (taskId: string) => Promise<{ ok: boolean }>;

  fsSaveText: (opts: {
    content: string;
    defaultName?: string;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;

  aiSummarize: (opts: {
    transcript: string;
    /** 未傳則依設置頁「預設摘要引擎」 */
    provider?: "openai" | "anthropic";
  }) => Promise<
    | { ok: true; summary: AiSummary }
    | { ok: false; error: string }
  >;

  aiTranslateGoogle: (opts: {
    segments: Pick<TranscriptSegment, "id" | "text">[];
    target: string;
  }) => Promise<{
    ok: boolean;
    results?: { id: string; text: string; error?: string }[];
    error?: string;
  }>;

  aiTranslateOpenAI: (opts: {
    segments: Pick<TranscriptSegment, "id" | "text">[];
    target: string;
  }) => Promise<{
    ok: boolean;
    results?: { id: string; text: string }[];
    error?: string;
  }>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
