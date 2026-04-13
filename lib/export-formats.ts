import type { TranscriptSegment } from "@/lib/types";

function speakerPrefix(seg: TranscriptSegment): string {
  const sp = seg.speaker?.trim();
  if (!sp || sp.toUpperCase() === "UNKNOWN") return "";
  return `[${sp}] `;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

/** SRT 時間碼 00:00:00,000 */
export function toSrtTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms).padStart(3, "0")}`;
}

/** 單檔：同一時間碼下原文與譯文各一行（播放器顯示為雙語字幕） */
export function buildSrtBilingualStacked(segments: TranscriptSegment[]): string {
  return segments
    .map((seg, i) => {
      const inner =
        seg.translatedText?.trim() ?
          `${seg.text}\n${seg.translatedText}`
        : seg.text;
      const text = `${speakerPrefix(seg)}${inner.trim()}`.trim();
      return `${i + 1}\n${toSrtTimestamp(seg.start)} --> ${toSrtTimestamp(seg.end)}\n${text}\n`;
    })
    .join("\n");
}

/** 與 buildSrtBilingualStacked 相同（向後相容） */
export const buildSrt = buildSrtBilingualStacked;

/** 僅原文軌 */
export function buildSrtOriginal(segments: TranscriptSegment[]): string {
  return segments
    .map((seg, i) => {
      const line = `${speakerPrefix(seg)}${seg.text.trim()}`.trim();
      return `${i + 1}\n${toSrtTimestamp(seg.start)} --> ${toSrtTimestamp(seg.end)}\n${line}\n`;
    })
    .join("\n");
}

/** 僅譯文軌（無譯文時略過該段） */
export function buildSrtTranslated(segments: TranscriptSegment[]): string {
  let n = 0;
  const parts: string[] = [];
  for (const seg of segments) {
    const tr = seg.translatedText?.trim();
    if (!tr) continue;
    n += 1;
    const line = `${speakerPrefix(seg)}${tr}`.trim();
    parts.push(
      `${n}\n${toSrtTimestamp(seg.start)} --> ${toSrtTimestamp(seg.end)}\n${line}\n`,
    );
  }
  return parts.join("\n");
}

export function buildTxt(
  segments: TranscriptSegment[],
  withTimestamp: boolean,
): string {
  return segments
    .map((seg) => {
      if (!withTimestamp) {
        const p = speakerPrefix(seg);
        const t = seg.translatedText?.trim();
        return t ? `${p}${seg.text}\n（譯）${t}` : `${p}${seg.text}`;
      }
      const ts = `${toSrtTimestamp(seg.start)}–${toSrtTimestamp(seg.end)}`;
      const p = speakerPrefix(seg);
      const t = seg.translatedText?.trim();
      return t ?
          `[${ts}] ${p}${seg.text}\n[譯] ${t}`
        : `[${ts}] ${p}${seg.text}`;
    })
    .join("\n\n");
}

/** 匯出彈窗：預覽文字與實際下載內容（SRT 檔永遠含時間碼；預覽可僅顯示純文字） */
export type ExportDialogFileFormat = "txt" | "srt";

export function buildExportDialogPayload(
  segments: TranscriptSegment[],
  opts: {
    format: ExportDialogFileFormat;
    showTimecode: boolean;
    /** TXT 且未顯示時間碼時，置於檔案與預覽頂端（通常為媒體檔名主體） */
    fileTitle?: string | null;
  },
): { previewText: string; downloadContent: string; defaultExtension: string } {
  if (opts.format === "txt") {
    let downloadContent = buildTxt(segments, opts.showTimecode);
    if (!opts.showTimecode) {
      const title = String(opts.fileTitle ?? "").trim();
      if (title) downloadContent = `標題：${title}\n\n${downloadContent}`;
    }
    return {
      previewText: downloadContent,
      downloadContent,
      defaultExtension: "txt",
    };
  }
  const downloadContent = buildSrtBilingualStacked(segments);
  const previewText =
    opts.showTimecode ? downloadContent : buildTxt(segments, false);
  return {
    previewText,
    downloadContent,
    defaultExtension: "srt",
  };
}
