"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Clapperboard } from "lucide-react";
import { MediaPlayer } from "@/components/media-player";
import { SubtitleEditList } from "@/components/subtitle-edit-list";
import { SubtitleTimeline } from "@/components/subtitle-timeline";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const t = target.tagName;
  return t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
}

export function SubtitleWorkspace({
  isActive = true,
}: {
  isActive?: boolean;
}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "z" || e.shiftKey) return;
      if (isEditableKeyboardTarget(e.target)) return;
      if (useAppStore.getState().segmentUndoStack.length === 0) return;
      e.preventDefault();
      useAppStore.getState().undoSegmentEdit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">字幕翻譯</h1>
        </div>
        <Link
          href="/"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-2")}
        >
          <Clapperboard className="size-4" />
          前往轉錄工作區
        </Link>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-2 lg:grid-rows-1">
        <Card className="flex min-h-[200px] min-w-0 flex-col overflow-auto p-4 lg:min-h-0">
          {isActive ?
            <MediaPlayer />
          : <div className="flex min-h-[120px] items-center justify-center text-center text-xs text-muted-foreground">
              目前於「轉錄」工作區。切換至「字幕翻譯」以預覽媒體與編輯時間軸。
            </div>
          }
        </Card>
        <Card className="flex min-h-[240px] min-w-0 flex-col overflow-hidden p-0 lg:min-h-0">
          <SubtitleEditList />
        </Card>
      </div>

      <Card className="shrink-0 p-4">
        {isActive ? <SubtitleTimeline /> : null}
      </Card>
    </div>
  );
}
