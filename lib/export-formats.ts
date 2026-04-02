import type { TranscriptSegment } from "@/lib/types";

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
      const text =
        seg.translatedText?.trim() ?
          `${seg.text}\n${seg.translatedText}`
        : seg.text;
      return `${i + 1}\n${toSrtTimestamp(seg.start)} --> ${toSrtTimestamp(seg.end)}\n${text.trim()}\n`;
    })
    .join("\n");
}

/** 與 buildSrtBilingualStacked 相同（向後相容） */
export const buildSrt = buildSrtBilingualStacked;

/** 僅原文軌 */
export function buildSrtOriginal(segments: TranscriptSegment[]): string {
  return segments
    .map((seg, i) => {
      return `${i + 1}\n${toSrtTimestamp(seg.start)} --> ${toSrtTimestamp(seg.end)}\n${seg.text.trim()}\n`;
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
    parts.push(
      `${n}\n${toSrtTimestamp(seg.start)} --> ${toSrtTimestamp(seg.end)}\n${tr}\n`,
    );
  }
  return parts.join("\n");
}

export function buildMarkdown(segments: TranscriptSegment[]): string {
  return segments
    .map((seg) => {
      const ts = `${toSrtTimestamp(seg.start).replace(",", ".")} – ${toSrtTimestamp(seg.end).replace(",", ".")}`;
      const line = `- [${ts}] ${seg.text}`;
      if (seg.translatedText?.trim()) {
        return `${line}\n  - *譯：${seg.translatedText.trim()}*`;
      }
      return line;
    })
    .join("\n\n");
}

export function buildTxt(
  segments: TranscriptSegment[],
  withTimestamp: boolean,
): string {
  return segments
    .map((seg) => {
      if (!withTimestamp) {
        const t = seg.translatedText?.trim();
        return t ? `${seg.text}\n（譯）${t}` : seg.text;
      }
      const ts = `${toSrtTimestamp(seg.start)}–${toSrtTimestamp(seg.end)}`;
      const t = seg.translatedText?.trim();
      return t ? `[${ts}] ${seg.text}\n[譯] ${t}` : `[${ts}] ${seg.text}`;
    })
    .join("\n\n");
}
