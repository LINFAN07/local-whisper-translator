const STORAGE_KEY = "voice-translator-timecode-click-mode";

export type TimecodeClickMode = "continue" | "segment";

export function readTimecodeClickMode(): TimecodeClickMode {
  if (typeof window === "undefined") return "continue";
  return localStorage.getItem(STORAGE_KEY) === "segment" ? "segment" : "continue";
}

export function writeTimecodeClickMode(mode: TimecodeClickMode) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, mode);
}
