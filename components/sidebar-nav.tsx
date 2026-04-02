"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";
import { LayoutDashboard, ListMusic, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { refreshTasksInStore } from "@/lib/persist-task";
import { useAppStore } from "@/lib/store";
import type { AiSummary } from "@/lib/types";

export function SidebarNav() {
  const pathname = usePathname();
  const router = useRouter();
  const tasks = useAppStore((s) => s.tasks);
  const setTasks = useAppStore((s) => s.setTasks);
  const replaceSegments = useAppStore((s) => s.replaceSegments);
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

  const loadTask = useCallback(
    async (taskId: string) => {
      const api = window.electronAPI;
      if (!api?.dbGetTask) return;
      const data = await api.dbGetTask(taskId);
      if (!data) return;
      router.push("/");
      const { task, segments } = data;
      const mapped = segments.map((s) => ({
        ...s,
        translatedText: s.translatedText ?? null,
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

  return (
    <aside className="flex h-full w-[220px] shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
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

      <div className="px-2 py-2">
        <p className="px-2 pb-1 text-xs font-medium uppercase text-muted-foreground">
          歷史紀錄
        </p>
        <ScrollArea className="h-[220px] pr-2">
          <ul className="space-y-0.5">
            {tasks.length === 0 ?
              <li className="px-2 py-2 text-xs text-muted-foreground">
                尚無紀錄；轉錄完成會自動儲存於此，亦可手動按「儲存紀錄」更新。
              </li>
            : tasks.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    )}
                    onClick={() => loadTask(t.id)}
                  >
                    <span className="truncate">{t.name}</span>
                  </button>
                </li>
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
          工作區
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
