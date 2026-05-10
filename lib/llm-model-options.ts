/** 設定畫面可選的模型 id；若使用者已儲存清單外的字串，UI 會額外顯示該值供保留 */

export const OPENAI_SUMMARY_MODEL_OPTIONS: string[] = [
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-4",
  "o1",
  "o1-mini",
  "o3-mini",
];

export const OPENAI_TRANSLATION_MODEL_OPTIONS: string[] = [
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-4",
];

export const ANTHROPIC_SUMMARY_MODEL_OPTIONS: string[] = [
  "claude-sonnet-4-20250514",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
  "claude-3-opus-20240229",
];

/** Google AI／Gemini（[預覽] 等名稱可能變更，可透過自訂值保留） */
export const GEMINI_SUMMARY_MODEL_OPTIONS: string[] = [
  "gemini-2.5-pro-preview-05-06",
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-1.5-pro",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
];

export const GEMINI_TRANSLATION_MODEL_OPTIONS: string[] = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
];

/** 翻譯：OpenAI 與 Gemini 合併清單（依 id 前綴在後端分流） */
export const TRANSLATION_MODEL_OPTIONS: string[] = [
  ...OPENAI_TRANSLATION_MODEL_OPTIONS,
  ...GEMINI_TRANSLATION_MODEL_OPTIONS,
];

/** 若目前值不在預設清單，仍要出現在下拉選單第一項以保留舊設定 */
export function selectOptionsWithCurrent(
  defaults: readonly string[],
  current: string,
): string[] {
  const c = current.trim();
  if (c && !defaults.includes(c)) return [c, ...defaults];
  return [...defaults];
}
