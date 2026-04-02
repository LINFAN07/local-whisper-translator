"use client";

import { useCallback, useState } from "react";
import { Upload, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ACCEPT = ".mp4,.mkv,.webm,.mov,.mp3,.wav,.m4a,audio/*,video/*";

type Props = {
  onFiles: (files: FileList | File[]) => void;
  onElectronPaths?: (paths: string[]) => void;
  disabled?: boolean;
  /** 與「貼上網址」並排時較矮的版面 */
  compact?: boolean;
};

export function DropZone({ onFiles, onElectronPaths, disabled, compact }: Props) {
  const [over, setOver] = useState(false);

  const openFilePicker = useCallback(async () => {
      if (disabled) return;
      if (typeof window !== "undefined" && window.electronAPI?.openFileDialog) {
        const p = await window.electronAPI.openFileDialog();
        if (p) onElectronPaths?.([p]);
        return;
      }
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ACCEPT;
      input.onchange = () => {
        if (input.files?.length) onFiles(input.files);
      };
      input.click();
  }, [disabled, onElectronPaths, onFiles]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      if (disabled) return;
      const dt = e.dataTransfer;
      if (!dt?.files?.length) return;

      if (
        onElectronPaths &&
        typeof window !== "undefined" &&
        window.electronAPI?.getPathForFile
      ) {
        const paths: string[] = [];
        for (let i = 0; i < dt.files.length; i++) {
          const f = dt.files.item(i);
          if (!f) continue;
          try {
            const p = window.electronAPI.getPathForFile(f);
            if (p) paths.push(p);
          } catch {
            /* ignore */
          }
        }
        if (paths.length) {
          onElectronPaths(paths);
          return;
        }
      }

      onFiles(dt.files);
    },
    [disabled, onFiles, onElectronPaths],
  );

  return (
    <div
      role="group"
      aria-label="拖放或選擇音訊／影片檔"
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-border bg-muted/30 transition-colors",
        compact ?
          "min-h-[200px] px-4 py-6 sm:min-h-[220px]"
        : "min-h-[280px] px-6 py-10",
        over && "border-primary/60 bg-muted/50",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      onClick={(e) => {
        if (disabled) return;
        if ((e.target as HTMLElement).closest("button")) return;
        void openFilePicker();
      }}
    >
      <div
        className={cn(
          "flex items-center justify-center rounded-full bg-background/80 shadow-sm ring-1 ring-border",
          compact ? "mb-2 size-11" : "mb-3 size-14",
        )}
      >
        <Upload
          className={cn("text-muted-foreground", compact ? "size-6" : "size-7")}
        />
      </div>
      <p className={cn("text-center text-sm font-medium", compact ? "mb-1" : "mb-1")}>
        拖放檔案到此，或選擇檔案
      </p>
      <p
        className={cn(
          "max-w-md text-center text-xs text-muted-foreground",
          compact ? "mb-4 line-clamp-4" : "mb-6",
        )}
      >
        {compact ?
          "支援 MP4、MKV、MP3、WAV 等。處理在您的電腦上執行，不會上傳到雲端。網址請使用左側卡片。"
        : "支援 MP4、MKV、MP3、WAV 等；亦可使用上方「貼上網址」下載影片至本機再轉錄（yt-dlp 支援的站皆可嘗試）。處理在您的電腦上執行，不會上傳到雲端。"}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        className="gap-2 pointer-events-auto"
        onClick={(e) => {
          e.stopPropagation();
          void openFilePicker();
        }}
      >
        <FolderOpen className="size-4" />
        選擇檔案
      </Button>
    </div>
  );
}
