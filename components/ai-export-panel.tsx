"use client";

import { useCallback, useEffect, useState } from "react";
import { Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAppStore } from "@/lib/store";

export function AiExportPanel() {
  const segments = useAppStore((s) => s.segments);
  const summary = useAppStore((s) => s.summary);
  const setSummary = useAppStore((s) => s.setSummary);
  const setAiBusy = useAppStore((s) => s.setAiBusy);

  const [summaryEngine, setSummaryEngine] = useState<"openai" | "anthropic">(
    "openai",
  );
  /** 須在掛載後再偵測 electronAPI，避免 SSR 為 null、客戶端有內容而 hydration 失敗 */
  const [electronReady, setElectronReady] = useState(false);

  useEffect(() => {
    setElectronReady(typeof window !== "undefined" && !!window.electronAPI);
  }, []);

  useEffect(() => {
    (async () => {
      if (!window.electronAPI?.settingsGet) return;
      const s = await window.electronAPI.settingsGet();
      if (s.summaryProvider === "anthropic") setSummaryEngine("anthropic");
      else setSummaryEngine("openai");
    })();
  }, []);

  const runSummarize = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.aiSummarize) return;
    const text = segments.map((s) => s.text).join("\n");
    if (!text.trim()) {
      alert("請先完成轉錄");
      return;
    }
    setAiBusy(true);
    try {
      const res = await api.aiSummarize({
        transcript: text,
        provider: summaryEngine,
      });
      if (!res.ok) {
        alert(res.error);
        return;
      }
      setSummary(res.summary);
    } finally {
      setAiBusy(false);
    }
  }, [segments, setSummary, setAiBusy, summaryEngine]);

  if (!electronReady) return null;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">AI 摘要</h3>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            value={summaryEngine}
            onChange={(e) =>
              setSummaryEngine(e.target.value as "openai" | "anthropic")
            }
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Claude</option>
          </select>
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            variant="secondary"
            disabled={segments.length === 0}
            onClick={runSummarize}
          >
            <Wand2 className="size-3.5" />
            一鍵總結
          </Button>
        </div>
      </div>
      {summary ?
        <div className="space-y-2 text-sm">
          <p className="font-semibold text-foreground">{summary.title}</p>
          <ul className="list-inside list-disc text-muted-foreground">
            {summary.bulletPoints.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
          {summary.actionItems.length > 0 ?
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                行動項
              </p>
              <ul className="list-inside list-decimal text-muted-foreground">
                {summary.actionItems.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          : null}
        </div>
      : (
        <p className="text-xs text-muted-foreground">
          使用設置頁的 OpenAI 或 Anthropic
          金鑰；可於上方切換本次引擎。僅送出逐字文字。
        </p>
      )}
    </Card>
  );
}
