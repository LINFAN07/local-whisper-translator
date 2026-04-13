import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 從本機路徑取出檔名（支援 Windows `\`、含 query 時先剔除） */
export function fileBasename(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, "/")
  const noQuery = normalized.split("?")[0] ?? normalized
  const slash = noQuery.lastIndexOf("/")
  return slash >= 0 ? noQuery.slice(slash + 1) : noQuery
}
