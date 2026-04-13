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
  /** 讀取本機媒體二進位（供波形解碼；避免 renderer fetch(media://) 失敗） */
  readMediaFile: (filePath: string) => Promise<Uint8Array | null>;
  openFileDialog: () => Promise<string | null>;
  /** 僅 YouTube 連結：是否可取得可解析字幕（供轉錄前詢問使用者） */
  youtubeProbeSubtitles: (url: string) => Promise<{
    ok: boolean;
    available?: boolean;
    label?: string;
    lang?: string;
    source?: string;
    error?: string;
  }>;
  /** 字串＝本機路徑或任意網址；物件可指定 YouTube 字幕策略 */
  transcribeStart: (
    payload:
      | string
      | {
          input: string;
          youtubeSubsMode?: "import" | "whisper";
        },
  ) => Promise<{ ok: boolean; error?: string }>;
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

  /** 主程序寫入系統剪貼簿（renderer 的 navigator.clipboard 在 file:// 等情境常失敗） */
  clipboardWriteText: (
    text: string,
  ) => Promise<{ ok: boolean; error?: string }>;

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

  /** 對本機媒體執行說話人分離並回傳各段 id 的 speaker 標籤 */
  assignSpeakers: (opts: {
    mediaPath: string;
    segments: Pick<TranscriptSegment, "id" | "start" | "end">[];
  }) => Promise<{
    ok: boolean;
    updates?: { id: string; speaker: string }[];
    error?: string;
  }>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
