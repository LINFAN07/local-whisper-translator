"use client";

import { useEffect, useId, useState } from "react";
import {
  readTimecodeClickMode,
  writeTimecodeClickMode,
  type TimecodeClickMode,
} from "@/lib/timecode-click-mode";

export function TimecodeClickModeControls() {
  const groupId = useId();
  const name = `${groupId}-timecode-click`;
  const [mode, setMode] = useState<TimecodeClickMode>("continue");

  useEffect(() => {
    setMode(readTimecodeClickMode());
  }, []);

  const set = (m: TimecodeClickMode) => {
    setMode(m);
    writeTimecodeClickMode(m);
  };

  return (
    <div className="space-y-1.5 text-xs text-muted-foreground">
      <p className="font-medium text-foreground/90">點擊時間碼後</p>
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="radio"
          className="border-border"
          name={name}
          checked={mode === "continue"}
          onChange={() => set("continue")}
        />
        <span>從該句開頭繼續播放</span>
      </label>
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="radio"
          className="border-border"
          name={name}
          checked={mode === "segment"}
          onChange={() => set("segment")}
        />
        <span>只播放該句（句末自動暫停）</span>
      </label>
    </div>
  );
}
