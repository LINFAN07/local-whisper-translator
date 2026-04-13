"use client";

import Link from "next/link";
import { Clapperboard } from "lucide-react";
import { MediaPlayer } from "@/components/media-player";
import { SubtitleEditList } from "@/components/subtitle-edit-list";
import { SubtitleTimeline } from "@/components/subtitle-timeline";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function SubtitleWorkspace() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">字幕翻譯</h1>
          <p className="text-sm text-muted-foreground">
            在下方時間軸拖曳字幕對齊音訊；右側可編輯原文與譯文並匯出。
          </p>
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
          <MediaPlayer />
        </Card>
        <Card className="flex min-h-[240px] min-w-0 flex-col overflow-hidden p-0 lg:min-h-0">
          <SubtitleEditList />
        </Card>
      </div>

      <Card className="shrink-0 p-4">
        <SubtitleTimeline />
      </Card>
    </div>
  );
}
