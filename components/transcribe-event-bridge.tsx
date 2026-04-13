"use client";

import { useTranscribeListener } from "@/hooks/use-transcribe-listener";

/** 掛在 dashboard layout，避免僅首頁掛載 listener 時切換路由導致收不到轉錄事件、歷史無法寫入 */
export function TranscribeEventBridge() {
  useTranscribeListener();
  return null;
}
