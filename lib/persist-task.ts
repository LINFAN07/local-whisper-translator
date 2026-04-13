import type { AiSummary, TaskItem, TranscriptSegment } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import type { DbTaskRow } from "@/types/electron";
import { fileBasename } from "@/lib/utils";

function dbRowsToTaskItems(rows: DbTaskRow[]): TaskItem[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    mediaPath: r.mediaPath ?? undefined,
    mediaName: r.mediaName ?? undefined,
    updatedAt: r.updatedAt,
  }));
}

/** 從資料庫重載左側歷史清單 */
export async function refreshTasksInStore(
  setTasks: (tasks: TaskItem[]) => void,
): Promise<void> {
  const rows = await window.electronAPI?.dbListTasks?.();
  if (!rows) return;
  setTasks(dbRowsToTaskItems(rows));
}

/** 儲存成功後立刻把該筆插入／更新到 store，避免 ScrollArea 等元件未重繪時左欄仍顯示空清單 */
export function mergeSavedTaskIntoHistoryList(meta: {
  taskId: string;
  createdAt: number;
  name: string;
  mediaPath: string | null;
  mediaName: string | null;
}): void {
  useAppStore.setState((st) => {
    const now = Date.now();
    const row: TaskItem = {
      id: meta.taskId,
      name: meta.name,
      createdAt: meta.createdAt,
      mediaPath: meta.mediaPath ?? undefined,
      mediaName: meta.mediaName ?? undefined,
      updatedAt: now,
    };
    const idx = st.tasks.findIndex((t) => t.id === meta.taskId);
    if (idx >= 0) {
      const tasks = [...st.tasks];
      tasks[idx] = { ...tasks[idx], ...row };
      return { tasks };
    }
    return { tasks: [row, ...st.tasks] };
  });
}

export type SaveWorkspaceSnapshotResult =
  | {
      ok: true;
      taskId: string;
      createdAt: number;
      taskName: string;
      savedMediaPath: string | null;
      savedMediaName: string | null;
    }
  | { ok: false; error?: string };

export interface WorkspaceSnapshot {
  segments: TranscriptSegment[];
  currentTaskId: string | null;
  taskCreatedAt: number | null;
  mediaName: string | null;
  mediaPath: string | null;
  summary: AiSummary | null;
}

export async function saveWorkspaceSnapshot(
  snap: WorkspaceSnapshot,
): Promise<SaveWorkspaceSnapshotResult> {
  const api = window.electronAPI;
  if (!api?.dbSaveTask)
    return { ok: false, error: "無法連線至本機資料庫（僅桌面版可用）" };
  if (snap.segments.length === 0)
    return { ok: false, error: "沒有可儲存的逐字稿" };

  const id = snap.currentTaskId ?? crypto.randomUUID();
  const createdAt = snap.taskCreatedAt ?? Date.now();
  const fromPathTitle =
    snap.mediaPath?.trim() ?
      fileBasename(snap.mediaPath).replace(/\.[^/.]+$/, "")
    : "";
  const name =
    snap.mediaName?.replace(/\.[^/.]+$/, "")?.trim() ||
    fromPathTitle ||
    `紀錄-${new Date(createdAt).toLocaleString("zh-TW")}`;

  const resolvedMediaName =
    snap.mediaName?.trim() ||
    (snap.mediaPath?.trim() ? fileBasename(snap.mediaPath) : null);

  const r = await api.dbSaveTask({
    task: {
      id,
      name,
      mediaPath: snap.mediaPath,
      mediaName: resolvedMediaName,
      summaryJson: snap.summary,
      createdAt,
    },
    segments: snap.segments,
  });

  if (!r.ok) return { ok: false, error: r.error ?? "儲存失敗" };
  return {
    ok: true,
    taskId: id,
    createdAt,
    taskName: name,
    savedMediaPath: snap.mediaPath,
    savedMediaName: resolvedMediaName,
  };
}
