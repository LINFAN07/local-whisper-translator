export type TranscriptEvent =
  | { type: "progress"; value: number; message?: string }
  | {
      type: "segment";
      start: number;
      end: number;
      text: string;
      speaker?: string | null;
    }
  | { type: "error"; message: string }
  | { type: "done"; code?: number }
  /** 連結輸入時，下載完成後的本機媒體路徑（供桌面版載入播放器）；title 為 yt-dlp 取得的串流標題（例如 YouTube 片名） */
  | { type: "downloaded"; path: string; title?: string | null };

export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  translatedText?: string | null;
  /** 說話人標籤，例如 SPEAKER_00 */
  speaker?: string | null;
}

export interface TaskItem {
  id: string;
  name: string;
  createdAt: number;
  /** 來自資料庫的額外欄位 */
  mediaPath?: string | null;
  mediaName?: string | null;
  updatedAt?: number;
}

export interface AiSummary {
  title: string;
  bulletPoints: string[];
  actionItems: string[];
}
