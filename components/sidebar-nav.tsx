"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  Captions,
  LayoutDashboard,
  ListMusic,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarHistoryCard } from "@/components/sidebar-history-card";
import { refreshTasksInStore } from "@/lib/persist-task";
import { useAppStore } from "@/lib/store";
import type { AiSummary } from "@/lib/types";

const SIDEBAR_COLLAPSED_KEY = "vt-sidebar-collapsed";

export function SidebarNav() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1") {
        setSidebarCollapsed(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const setCollapsedPersisted = useCallback((v: boolean) => {
    setSidebarCollapsed(v);
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, []);
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
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground",
        sidebarCollapsed ? "w-[52px]" : "w-[248px]",
      )}
      aria-label="側邊導航"
    >
      {sidebarCollapsed ?
        <div className="flex flex-col items-center gap-1 border-b border-sidebar-border py-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0"
            title="展開側邊欄"
            aria-label="展開側邊欄"
            onClick={() => setCollapsedPersisted(false)}
          >
            <PanelLeftOpen className="size-4" />
          </Button>
          <div className="flex size-8 items-center justify-center rounded-md bg-sidebar-primary/20 text-sidebar-primary">
            <ListMusic className="size-4" />
          </div>
        </div>
      : <div className="flex items-center gap-2 border-b border-sidebar-border px-3 py-3">
          <div className="flex size-8 items-center justify-center rounded-md bg-sidebar-primary/20 text-sidebar-primary">
            <ListMusic className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tracking-tight">
              語音轉譯
            </p>
            <p className="text-xs text-muted-foreground">本機 Whisper</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0"
            title="收合側邊欄"
            aria-label="收合側邊欄"
            onClick={() => setCollapsedPersisted(true)}
          >
            <PanelLeftClose className="size-4" />
          </Button>
        </div>
      }

      {!sidebarCollapsed && (
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
      )}

      <div
        className={cn(
          "mt-auto flex flex-col gap-1 border-t border-sidebar-border",
          sidebarCollapsed ? "p-1.5" : "p-2",
        )}
      >
        <Link
          href="/"
          title="轉錄"
          className={cn(
            buttonVariants({
              variant:
                pathname === "/" || pathname === "" ? "secondary" : "ghost",
              size: sidebarCollapsed ? "icon-sm" : "sm",
            }),
            sidebarCollapsed ? "w-full" : "w-full justify-start gap-2",
          )}
        >
          <LayoutDashboard className="size-4 shrink-0" />
          {!sidebarCollapsed && "轉錄"}
        </Link>
        <Link
          href="/subtitle"
          title="字幕翻譯"
          className={cn(
            buttonVariants({
              variant: pathname === "/subtitle" ? "secondary" : "ghost",
              size: sidebarCollapsed ? "icon-sm" : "sm",
            }),
            sidebarCollapsed ? "w-full" : "w-full justify-start gap-2",
          )}
        >
          <Captions className="size-4 shrink-0" />
          {!sidebarCollapsed && "字幕翻譯"}
        </Link>
        <Link
          href="/settings"
          title="設置"
          className={cn(
            buttonVariants({
              variant: pathname === "/settings" ? "secondary" : "ghost",
              size: sidebarCollapsed ? "icon-sm" : "sm",
            }),
            sidebarCollapsed ? "w-full" : "w-full justify-start gap-2",
          )}
        >
          <Settings className="size-4 shrink-0" />
          {!sidebarCollapsed && "設置"}
        </Link>
      </div>
    </aside>
  );
}
