import type { AiSummary, TaskItem, TranscriptSegment } from "@/lib/types";
import type { DbTaskRow } from "@/types/electron";

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
): Promise<{ ok: boolean; error?: string; taskId?: string; createdAt?: number }> {
  const api = window.electronAPI;
  if (!api?.dbSaveTask)
    return { ok: false, error: "無法連線至本機資料庫（僅桌面版可用）" };
  if (snap.segments.length === 0)
    return { ok: false, error: "沒有可儲存的逐字稿" };

  const id = snap.currentTaskId ?? crypto.randomUUID();
  const createdAt = snap.taskCreatedAt ?? Date.now();
  const name =
    snap.mediaName?.replace(/\.[^/.]+$/, "") ??
    `紀錄-${new Date(createdAt).toLocaleString("zh-TW")}`;

  const r = await api.dbSaveTask({
    task: {
      id,
      name,
      mediaPath: snap.mediaPath,
      mediaName: snap.mediaName,
      summaryJson: snap.summary,
      createdAt,
    },
    segments: snap.segments,
  });

  if (!r.ok) return { ok: false, error: r.error ?? "儲存失敗" };
  return { ok: true, taskId: id, createdAt };
}
