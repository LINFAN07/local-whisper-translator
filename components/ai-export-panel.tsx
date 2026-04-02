"use client";

import { useCallback, useEffect, useState } from "react";
import { FileDown, Languages, Save, Sparkles, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAppStore } from "@/lib/store";
import {
  buildMarkdown,
  buildSrtBilingualStacked,
  buildSrtOriginal,
  buildSrtTranslated,
  buildTxt,
} from "@/lib/export-formats";
import {
  refreshTasksInStore,
  saveWorkspaceSnapshot,
} from "@/lib/persist-task";

export function AiExportPanel() {
  const segments = useAppStore((s) => s.segments);
  const summary = useAppStore((s) => s.summary);
  const setSummary = useAppStore((s) => s.setSummary);
  const mediaName = useAppStore((s) => s.mediaName);
  const mediaPath = useAppStore((s) => s.mediaPath);
  const currentTaskId = useAppStore((s) => s.currentTaskId);
  const taskCreatedAt = useAppStore((s) => s.taskCreatedAt);
  const setCurrentTaskId = useAppStore((s) => s.setCurrentTaskId);
  const setTaskCreatedAt = useAppStore((s) => s.setTaskCreatedAt);
  const setAiBusy = useAppStore((s) => s.setAiBusy);
  const setSegmentTranslations = useAppStore((s) => s.setSegmentTranslations);
  const setTasks = useAppStore((s) => s.setTasks);

  const [targetLang, setTargetLang] = useState("zh-TW");
  const [translateEngine, setTranslateEngine] = useState<"google" | "openai">(
    "google",
  );
  const [summaryEngine, setSummaryEngine] = useState<"openai" | "anthropic">(
    "openai",
  );
  /** 須在掛載後再偵測 electronAPI，避免 SSR 為 null、客戶端有內容而 hydration 失敗 */
  const [electronReady, setElectronReady] = useState(false);

  const baseExportName = (mediaName ?? "字幕").replace(/\.[^/.]+$/, "");

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

  const saveToDb = useCallback(async () => {
    const r = await saveWorkspaceSnapshot({
      segments,
      currentTaskId,
      taskCreatedAt,
      mediaName,
      mediaPath,
      summary,
    });
    if (!r.ok) {
      alert(r.error ?? "儲存失敗");
      return;
    }
    if (r.taskId) setCurrentTaskId(r.taskId);
    if (r.createdAt != null) setTaskCreatedAt(r.createdAt);
    await refreshTasksInStore(setTasks);
  }, [
    segments,
    currentTaskId,
    taskCreatedAt,
    mediaName,
    mediaPath,
    summary,
    setCurrentTaskId,
    setTaskCreatedAt,
    setTasks,
  ]);

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

  const runTranslate = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    if (segments.length === 0) {
      alert("沒有段落可翻譯");
      return;
    }
    const payload = {
      segments: segments.map((s) => ({ id: s.id, text: s.text })),
      target: targetLang,
    };
    setAiBusy(true);
    try {
      const res =
        translateEngine === "google" ?
          await api.aiTranslateGoogle(payload)
        : await api.aiTranslateOpenAI(payload);
      if (!res.ok || !res.results) {
        alert(
          res && typeof res === "object" && "error" in res && res.error
            ? String(res.error)
            : "翻譯失敗",
        );
        return;
      }
      const updates = res.results
        .filter((x) => x.text)
        .map((x) => ({ id: x.id, text: x.text }));
      setSegmentTranslations(updates);
      const errs = res.results.filter((x) => "error" in x && x.error);
      if (errs.length) {
        alert(`部分段落翻譯失敗（${errs.length} 段）`);
      }
    } finally {
      setAiBusy(false);
    }
  }, [segments, targetLang, translateEngine, setSegmentTranslations, setAiBusy]);

  const saveExport = useCallback(
    async (
      content: string,
      defaultName: string,
      filters: { name: string; extensions: string[] }[],
    ) => {
      const r = await window.electronAPI?.fsSaveText?.({
        content,
        defaultName,
        filters,
      });
      if (r?.canceled) return;
      if (!r?.ok) alert(r?.error ?? "匯出失敗");
    },
    [],
  );

  if (!electronReady) return null;

  const hasAnyTranslation = segments.some((s) =>
    Boolean(s.translatedText?.trim()),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={segments.length === 0}
          onClick={saveToDb}
        >
          <Save className="size-3.5" />
          儲存紀錄
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={segments.length === 0}
          onClick={() =>
            saveExport(
              buildSrtBilingualStacked(segments),
              `${baseExportName}.bilingual.srt`,
              [{ name: "SRT", extensions: ["srt"] }],
            )
          }
          title="同一時間碼內原文與譯文各一行"
        >
          <FileDown className="size-3.5" />
          SRT 雙語單檔
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={segments.length === 0}
          onClick={() =>
            saveExport(buildSrtOriginal(segments), `${baseExportName}.原文.srt`, [
              { name: "SRT", extensions: ["srt"] },
            ])
          }
        >
          SRT 原文
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={segments.length === 0 || !hasAnyTranslation}
          onClick={() =>
            saveExport(
              buildSrtTranslated(segments),
              `${baseExportName}.譯文.srt`,
              [{ name: "SRT", extensions: ["srt"] }],
            )
          }
        >
          SRT 譯文
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={segments.length === 0 || !hasAnyTranslation}
          onClick={async () => {
            const o1 = await window.electronAPI?.fsSaveText?.({
              content: buildSrtOriginal(segments),
              defaultName: `${baseExportName}.原文.srt`,
              filters: [{ name: "SRT", extensions: ["srt"] }],
            });
            if (o1?.canceled) return;
            await window.electronAPI?.fsSaveText?.({
              content: buildSrtTranslated(segments),
              defaultName: `${baseExportName}.譯文.srt`,
              filters: [{ name: "SRT", extensions: ["srt"] }],
            });
          }}
          title="連續兩次另存：先原文、再譯文（兩條字幕軌）"
        >
          SRT 雙檔
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={segments.length === 0}
          onClick={() =>
            saveExport(
              buildMarkdown(segments),
              `${baseExportName}.md`,
              [{ name: "Markdown", extensions: ["md"] }],
            )
          }
        >
          Markdown
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={segments.length === 0}
          onClick={() =>
            saveExport(
              buildTxt(segments, true),
              `${baseExportName}.txt`,
              [{ name: "文字檔", extensions: ["txt"] }],
            )
          }
        >
          TXT
        </Button>
      </div>

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

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Languages className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">翻譯</h3>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="tgt-lang">
              目標語言
            </label>
            <select
              id="tgt-lang"
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
            >
              <option value="zh-TW">繁體中文</option>
              <option value="ja">日文</option>
              <option value="en">英文</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="engine">
              引擎
            </label>
            <select
              id="engine"
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={translateEngine}
              onChange={(e) =>
                setTranslateEngine(e.target.value as "google" | "openai")
              }
            >
              <option value="google">Google 翻譯（免費／非官方）</option>
              <option value="openai">OpenAI</option>
            </select>
          </div>
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            disabled={segments.length === 0}
            onClick={runTranslate}
          >
            <Sparkles className="size-3.5" />
            翻譯全部段落
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Google 路徑有節流延遲；OpenAI
          需於設置填寫金鑰。譯文與原文對齊於右側逐字稿。
        </p>
      </Card>
    </div>
  );
}
