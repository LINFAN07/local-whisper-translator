"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";
import { Captions, LayoutDashboard, ListMusic, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarHistoryCard } from "@/components/sidebar-history-card";
import { refreshTasksInStore } from "@/lib/persist-task";
import { useAppStore } from "@/lib/store";
import type { AiSummary } from "@/lib/types";

export function SidebarNav() {
  const pathname = usePathname();
  const router = useRouter();
  const tasks = useAppStore((s) => s.tasks);
  const setTasks = useAppStore((s) => s.setTasks);
  const replaceSegments = useAppStore((s) => s.replaceSegments);
  const clearSegments = useAppStore((s) => s.clearSegments);
  const setMedia = useAppStore((s) => s.setMedia);
  const setSummary = useAppStore((s) => s.setSummary);
  const setCurrentTaskId = useAppStore((s) => s.setCurrentTaskId);
  const setTaskCreatedAt = useAppStore((s) => s.setTaskCreatedAt);
  const setProgress = useAppStore((s) => s.setProgress);
  const setStatus = useAppStore((s) => s.setStatus);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!window.electronAPI?.dbListTasks) return;
      await refreshTasksInStore((tasks) => {
        if (cancelled) return;
        setTasks(tasks);
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [setTasks]);

  /** 切換轉錄／字幕翻譯等路由時清除「點時間碼後要播」旗標，避免新頁 MediaPlayer 掛載時誤觸自動播放 */
  useEffect(() => {
    useAppStore.getState().clearPlayAfterSeek();
  }, [pathname]);

  const loadTask = useCallback(
    async (taskId: string) => {
      const api = window.electronAPI;
      if (!api?.dbGetTask) return;
      const data = await api.dbGetTask(taskId);
      if (!data) return;
      router.push(pathname || "/");
      const { task, segments } = data;
      const mapped = segments.map((s) => ({
        ...s,
        translatedText: s.translatedText ?? null,
        speaker: s.speaker ?? null,
      }));
      replaceSegments(mapped);
      setCurrentTaskId(task.id);
      setTaskCreatedAt(task.createdAt);
      if (task.summaryJson) {
        try {
          const s = JSON.parse(task.summaryJson) as AiSummary;
          setSummary(
            s?.title ?
              {
                title: s.title,
                bulletPoints: Array.isArray(s.bulletPoints) ? s.bulletPoints : [],
                actionItems: Array.isArray(s.actionItems) ? s.actionItems : [],
              }
            : null,
          );
        } catch {
          setSummary(null);
        }
      } else {
        setSummary(null);
      }
      if (task.mediaPath) {
        const url = await api.getFileUrl(task.mediaPath);
        if (url) {
          setMedia({
            src: url,
            path: task.mediaPath,
            name: task.mediaName ?? undefined,
          });
        } else {
          setMedia({
            src: null,
            path: task.mediaPath,
            name: task.mediaName ?? undefined,
          });
        }
      } else {
        setMedia({
          src: null,
          path: null,
          name: task.mediaName ?? undefined,
        });
      }
      setProgress(0, "");
      setStatus("idle");
    },
    [
      pathname,
      replaceSegments,
      router,
      setCurrentTaskId,
      setMedia,
      setProgress,
      setStatus,
      setSummary,
      setTaskCreatedAt,
    ],
  );

  const deleteHistoryTask = useCallback(
    async (taskId: string) => {
      const ok = window.confirm(
        "確定要刪除此筆歷史紀錄？\n刪除後無法復原。",
      );
      if (!ok) return;
      const api = window.electronAPI;
      if (!api?.dbDeleteTask) return;
      const r = await api.dbDeleteTask(taskId);
      if (!r.ok) return;
      await refreshTasksInStore(setTasks);
      if (useAppStore.getState().currentTaskId === taskId) {
        clearSegments();
        setCurrentTaskId(null);
        setTaskCreatedAt(null);
        setMedia({ src: null, path: null, name: null });
        setSummary(null);
        setProgress(0, "");
        setStatus("idle", "");
      }
    },
    [
      clearSegments,
      setCurrentTaskId,
      setMedia,
      setProgress,
      setStatus,
      setSummary,
      setTaskCreatedAt,
      setTasks,
    ],
  );

  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 border-b border-sidebar-border px-3 py-3">
        <div className="flex size-8 items-center justify-center rounded-md bg-sidebar-primary/20 text-sidebar-primary">
          <ListMusic className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold tracking-tight">
            語音轉譯
          </p>
          <p className="text-xs text-muted-foreground">本機 Whisper</p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-2 py-2">
        <p className="shrink-0 px-2 pb-2 text-xs font-medium uppercase text-muted-foreground">
          歷史紀錄
        </p>
        <ScrollArea
          className="min-h-0 flex-1 pr-2"
          key={tasks.map((t) => t.id).join("|")}
        >
          <ul className="space-y-2 pb-1">
            {tasks.length === 0 ?
              <li className="px-2 py-2 text-xs text-muted-foreground">
                尚無紀錄；轉錄完成會自動儲存於此，亦可手動按「儲存紀錄」更新。
              </li>
            : tasks.map((t) => (
                <SidebarHistoryCard
                  key={t.id}
                  task={t}
                  onSelect={loadTask}
                  onDelete={deleteHistoryTask}
                />
              ))
            }
          </ul>
        </ScrollArea>
      </div>

      <div className="mt-auto flex flex-col gap-1 border-t border-sidebar-border p-2">
        <Link
          href="/"
          className={cn(
            buttonVariants({
              variant:
                pathname === "/" || pathname === "" ? "secondary" : "ghost",
              size: "sm",
            }),
            "w-full justify-start gap-2",
          )}
        >
          <LayoutDashboard className="size-4 shrink-0" />
          轉錄
        </Link>
        <Link
          href="/subtitle"
          className={cn(
            buttonVariants({
              variant: pathname === "/subtitle" ? "secondary" : "ghost",
              size: "sm",
            }),
            "w-full justify-start gap-2",
          )}
        >
          <Captions className="size-4 shrink-0" />
          字幕翻譯
        </Link>
        <Link
          href="/settings"
          className={cn(
            buttonVariants({
              variant: pathname === "/settings" ? "secondary" : "ghost",
              size: "sm",
            }),
            "w-full justify-start gap-2",
          )}
        >
          <Settings className="size-4 shrink-0" />
          設置
        </Link>
      </div>
    </aside>
  );
}
