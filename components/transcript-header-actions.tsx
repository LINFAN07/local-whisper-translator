"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Copy,
  FileDown,
  Languages,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAppStore } from "@/lib/store";
import {
  buildExportDialogPayload,
  buildSrtBilingualStacked,
  buildSrtOriginal,
  buildSrtTranslated,
} from "@/lib/export-formats";

export function TranscriptHeaderActions() {
  const segments = useAppStore((s) => s.segments);
  const status = useAppStore((s) => s.status);
  const mediaName = useAppStore((s) => s.mediaName);
  const mediaPath = useAppStore((s) => s.mediaPath);
  const setAiBusy = useAppStore((s) => s.setAiBusy);
  const setSegmentTranslations = useAppStore((s) => s.setSegmentTranslations);
  const setSegmentSpeakers = useAppStore((s) => s.setSegmentSpeakers);
  const clearAllSpeakers = useAppStore((s) => s.clearAllSpeakers);
  const aiBusy = useAppStore((s) => s.aiBusy);

  const [targetLang, setTargetLang] = useState("zh-TW");
  const [translateEngine, setTranslateEngine] = useState<"google" | "openai">(
    "google",
  );
  const [electronReady, setElectronReady] = useState(false);
  const [openMenu, setOpenMenu] = useState<"speaker" | "translate" | null>(
    null,
  );
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportShowTimecode, setExportShowTimecode] = useState(false);
  const [exportFileFormat, setExportFileFormat] = useState<"txt" | "srt">(
    "txt",
  );
  const [exportDownloadMenuOpen, setExportDownloadMenuOpen] = useState(false);
  const [exportDownloadMenuLayout, setExportDownloadMenuLayout] = useState<{
    left: number;
    minWidth: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const [copyAck, setCopyAck] = useState(false);
  const [speakerBusy, setSpeakerBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const exportDownloadAnchorRef = useRef<HTMLButtonElement>(null);
  const exportDownloadMenuPanelRef = useRef<HTMLDivElement>(null);

  const baseExportName = (mediaName ?? "字幕").replace(/\.[^/.]+$/, "");

  useEffect(() => {
    setElectronReady(typeof window !== "undefined" && !!window.electronAPI);
  }, []);

  useEffect(() => {
    if (!openMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (
        wrapRef.current &&
        !wrapRef.current.contains(e.target as Node)
      ) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [openMenu]);

  useEffect(() => {
    if (segments.length === 0 && openMenu === "speaker") {
      setOpenMenu(null);
    }
    if (segments.length === 0 && exportModalOpen) {
      setExportModalOpen(false);
    }
  }, [segments.length, openMenu, exportModalOpen]);

  useEffect(() => {
    if (!exportModalOpen) {
      setExportDownloadMenuOpen(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (exportDownloadMenuOpen) {
        setExportDownloadMenuOpen(false);
        return;
      }
      setExportModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exportModalOpen, exportDownloadMenuOpen]);

  const updateExportDownloadMenuLayout = useCallback(() => {
    const el = exportDownloadAnchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    const gap = 4;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minWidth = Math.min(Math.max(r.width, 240), vw - pad * 2);
    let left = r.left;
    left = Math.min(left, vw - minWidth - pad);
    left = Math.max(pad, left);
    const estMenuH = 280;
    const belowTop = r.bottom + gap;
    const flipUp =
      belowTop + estMenuH > vh - pad && r.top > estMenuH + pad;
    if (flipUp) {
      setExportDownloadMenuLayout({
        left,
        minWidth,
        bottom: vh - r.top + gap,
      });
    } else {
      setExportDownloadMenuLayout({
        left,
        minWidth,
        top: belowTop,
      });
    }
  }, []);

  useLayoutEffect(() => {
    if (!exportDownloadMenuOpen) {
      setExportDownloadMenuLayout(null);
      return;
    }
    updateExportDownloadMenuLayout();
    const onWin = () => updateExportDownloadMenuLayout();
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);
    return () => {
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
    };
  }, [exportDownloadMenuOpen, updateExportDownloadMenuLayout]);

  useEffect(() => {
    if (!exportDownloadMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (exportDownloadAnchorRef.current?.contains(t)) return;
      if (exportDownloadMenuPanelRef.current?.contains(t)) return;
      setExportDownloadMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [exportDownloadMenuOpen]);

  const runTranslate = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) {
      alert("請在應用程式視窗內使用翻譯（瀏覽器分頁無法呼叫主程序）。");
      return;
    }
    const invoke =
      translateEngine === "google" ? api.aiTranslateGoogle : api.aiTranslateOpenAI;
    if (typeof invoke !== "function") {
      alert("目前環境不支援此翻譯管道，請更新或重新安裝應用程式。");
      return;
    }
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
      const res = await invoke(payload);
      if (!res.ok || !res.results) {
        alert(
          res && typeof res === "object" && "error" in res && res.error
            ? String(res.error)
            : "翻譯失敗",
        );
        return;
      }
      const updates = res.results
        .filter((x) => String(x.text ?? "").trim())
        .map((x) => ({ id: x.id, text: x.text }));
      setSegmentTranslations(updates);
      const errs = res.results.filter((x) => "error" in x && x.error);
      const okCount = res.results.filter((x) =>
        String(x.text ?? "").trim(),
      ).length;
      if (errs.length) {
        const hint =
          okCount > 0 ?
            `已成功 ${okCount} 段。`
          : "";
        alert(
          `部分段落翻譯失敗（${errs.length} 段）。${hint}常見原因為 Google 免費翻譯連線限流或網路不穩，請稍後再按一次翻譯，或改用設定中的 OpenAI 翻譯。`,
        );
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
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

  const exportPayload = useMemo(
    () =>
      buildExportDialogPayload(segments, {
        format: exportFileFormat,
        showTimecode: exportShowTimecode,
        fileTitle: baseExportName,
      }),
    [segments, exportFileFormat, exportShowTimecode, baseExportName],
  );

  const copyExportPreview = useCallback(async () => {
    const text = exportPayload.previewText;
    const showAck = () => {
      setCopyAck(true);
      window.setTimeout(() => setCopyAck(false), 2000);
    };

    const api = window.electronAPI;
    if (api?.clipboardWriteText) {
      const r = await api.clipboardWriteText(text);
      if (r?.ok) {
        showAck();
        return;
      }
    }

    try {
      await navigator.clipboard.writeText(text);
      showAck();
      return;
    } catch {
      /* 改試 execCommand，不顯示彈窗 */
    }

    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) showAck();
    } catch {
      /* 靜默失敗，不跳出 alert */
    }
  }, [exportPayload.previewText]);

  const downloadFromExportModal = useCallback(async () => {
    const ext = exportPayload.defaultExtension;
    const defaultName =
      ext === "srt" ? `${baseExportName}.srt` : `${baseExportName}.txt`;
    const filters =
      ext === "srt" ?
        [{ name: "SRT", extensions: ["srt"] }]
      : [{ name: "文字檔", extensions: ["txt"] }];
    await saveExport(exportPayload.downloadContent, defaultName, filters);
  }, [baseExportName, exportPayload, saveExport]);

  const runAssignSpeakers = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.assignSpeakers) return;
    if (!mediaPath?.trim()) {
      alert("需要本機媒體檔路徑才能識別說話人（請由檔案或歷史紀錄載入含媒體的逐字稿）。");
      return;
    }
    if (segments.length === 0) {
      alert("沒有段落可標註");
      return;
    }
    setSpeakerBusy(true);
    try {
      const res = await api.assignSpeakers({
        mediaPath: mediaPath.trim(),
        segments: segments.map((s) => ({
          id: s.id,
          start: s.start,
          end: s.end,
        })),
      });
      if (!res.ok || !res.updates?.length) {
        alert(res.error ?? "說話人識別失敗");
        return;
      }
      setSegmentSpeakers(
        res.updates.map((u) => ({ id: u.id, speaker: u.speaker })),
      );
    } finally {
      setSpeakerBusy(false);
    }
  }, [mediaPath, segments, setSegmentSpeakers]);

  if (!electronReady) return null;

  const hasAnyTranslation = segments.some((s) =>
    Boolean(s.translatedText?.trim()),
  );
  const disabledNoSeg = segments.length === 0;
  const transcribing = status === "processing";
  const hasLocalMedia = Boolean(mediaPath?.trim());
  const speakerIdentifyDisabled =
    disabledNoSeg ||
    transcribing ||
    !hasLocalMedia ||
    speakerBusy ||
    aiBusy;

  const menuClass =
    "absolute right-0 top-full z-[100] mt-1 w-[min(280px,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-3 shadow-md";

  return (
    <>
    <div ref={wrapRef} className="flex shrink-0 flex-wrap items-center gap-1.5">
      <div className="relative">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1 pr-1.5"
          disabled={disabledNoSeg}
          aria-expanded={openMenu === "speaker"}
          title={
            disabledNoSeg ? "請先完成轉錄" : (
              !hasLocalMedia ?
                "需本機媒體檔（非僅連結暫存）才能分析語者"
              : transcribing ?
                "轉錄進行中"
              : aiBusy ?
                "其他 AI 工作進行中"
              : undefined
            )
          }
          onClick={() =>
            setOpenMenu((m) => (m === "speaker" ? null : "speaker"))
          }
        >
          <Users className="size-3.5" />
          說話人
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
        {openMenu === "speaker" && !disabledNoSeg ?
          <div className={menuClass}>
            <div className="space-y-2 text-xs text-muted-foreground">
              <p>
                使用本機 pyannote
                套件分析音訊；首次執行會下載模型。請於設定頁填入 Hugging
                Face 權杖並接受模型條款，另請安裝{" "}
                <code className="rounded bg-muted px-0.5">requirements-speaker.txt</code>。
              </p>
              <Button
                type="button"
                size="sm"
                className="w-full gap-1.5"
                disabled={speakerIdentifyDisabled}
                onClick={async () => {
                  await runAssignSpeakers();
                  setOpenMenu(null);
                }}
              >
                <Sparkles className="size-3.5" />
                {speakerBusy ? "識別中…" : "執行說話人識別"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="w-full"
                disabled={disabledNoSeg || !segments.some((s) => s.speaker?.trim())}
                onClick={() => {
                  clearAllSpeakers();
                  setOpenMenu(null);
                }}
              >
                清除說話人標籤
              </Button>
            </div>
          </div>
        : null}
      </div>

      <div className="relative">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1 pr-1.5"
          aria-expanded={openMenu === "translate"}
          onClick={() =>
            setOpenMenu((m) => (m === "translate" ? null : "translate"))
          }
        >
          <Languages className="size-3.5" />
          翻譯
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
        {openMenu === "translate" ?
          <div className={menuClass}>
            <div className="space-y-2">
              <div className="space-y-1">
                <label
                  className="text-xs text-muted-foreground"
                  htmlFor="th-tgt-lang"
                >
                  目標語言
                </label>
                <select
                  id="th-tgt-lang"
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={targetLang}
                  onChange={(e) => setTargetLang(e.target.value)}
                >
                  <option value="zh-TW">繁體中文</option>
                  <option value="ja">日文</option>
                  <option value="en">英文</option>
                </select>
              </div>
              <div className="space-y-1">
                <label
                  className="text-xs text-muted-foreground"
                  htmlFor="th-engine"
                >
                  引擎
                </label>
                <select
                  id="th-engine"
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
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
                className="w-full gap-1.5"
                disabled={disabledNoSeg || aiBusy}
                title={
                  aiBusy ? "其他 AI 工作進行中" : undefined
                }
                onClick={async () => {
                  await runTranslate();
                  setOpenMenu(null);
                }}
              >
                <Sparkles className="size-3.5" />
                {aiBusy ? "處理中…" : "翻譯全部段落"}
              </Button>
            </div>
          </div>
        : null}
      </div>

      <div className="relative">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={disabledNoSeg}
          title={disabledNoSeg ? "請先完成轉錄後再匯出" : undefined}
          onClick={() => {
            if (disabledNoSeg) return;
            setExportShowTimecode(false);
            setExportFileFormat("txt");
            setExportModalOpen(true);
          }}
        >
          <FileDown className="size-3.5" />
          匯出
        </Button>
      </div>
    </div>

    {exportModalOpen && !disabledNoSeg && typeof document !== "undefined" ?
      createPortal(
      <div
        className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        onClick={() => setExportModalOpen(false)}
      >
        <Card
          className="flex max-h-[min(90vh,720px)] w-full max-w-2xl flex-col overflow-hidden shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h2
              id="export-dialog-title"
              className="text-base font-semibold tracking-tight"
            >
              匯出
            </h2>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label="關閉"
              onClick={() => setExportModalOpen(false)}
            >
              <X className="size-4" />
            </Button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="flex min-h-[200px] max-h-[min(45vh,320px)] flex-1 flex-col gap-1.5 border-b border-border px-4 py-3">
              <p className="text-xs text-muted-foreground">
                全文預覽
              </p>
              <textarea
                readOnly
                className="min-h-0 flex-1 resize-none rounded-md border border-neutral-200 bg-neutral-100 p-3 font-mono text-sm leading-relaxed text-neutral-900 outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring dark:border-neutral-600"
                value={exportPayload.previewText}
                spellCheck={false}
              />
            </div>

            <div className="shrink-0 space-y-3 overflow-y-auto px-4 py-3">
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 rounded border-input accent-primary"
                    checked={exportShowTimecode}
                    onChange={(e) => setExportShowTimecode(e.target.checked)}
                  />
                  顯示時間碼
                </label>
              </div>

              <fieldset className="space-y-1.5">
                <legend className="text-xs font-medium text-muted-foreground">
                  檔案格式
                </legend>
                <div className="flex flex-wrap gap-4">
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="radio"
                      className="size-4 border-input accent-primary"
                      name="export-file-format"
                      checked={exportFileFormat === "txt"}
                      onChange={() => setExportFileFormat("txt")}
                    />
                    TXT
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="radio"
                      className="size-4 border-input accent-primary"
                      name="export-file-format"
                      checked={exportFileFormat === "srt"}
                      onChange={() => setExportFileFormat("srt")}
                    />
                    SRT
                  </label>
                </div>
              </fieldset>

              {exportFileFormat === "srt" && !exportShowTimecode ?
                <p className="text-xs leading-relaxed text-muted-foreground">
                  預覽為純文字方便閱讀；下載的 SRT 檔仍含完整時間碼與編號。
                </p>
              : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="gap-1.5"
                  onClick={() => void copyExportPreview()}
                >
                  <Copy className="size-3.5" />
                  {copyAck ? "已複製" : "複製全文"}
                </Button>
                <Button
                  ref={exportDownloadAnchorRef}
                  type="button"
                  size="sm"
                  className="gap-1 pr-1.5"
                  aria-expanded={exportDownloadMenuOpen}
                  aria-haspopup="menu"
                  onClick={() => setExportDownloadMenuOpen((o) => !o)}
                >
                  <FileDown className="size-3.5" />
                  下載檔案
                  <ChevronDown className="size-3.5 opacity-70" />
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </div>,
      document.body,
      )
    : null}
    {exportDownloadMenuOpen &&
    exportDownloadMenuLayout &&
    exportModalOpen &&
    typeof document !== "undefined" ?
      createPortal(
        <div
          ref={exportDownloadMenuPanelRef}
          className="fixed z-[10002] max-h-[min(60vh,320px)] overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
          style={{
            left: exportDownloadMenuLayout.left,
            minWidth: exportDownloadMenuLayout.minWidth,
            ...(exportDownloadMenuLayout.top !== undefined ?
              { top: exportDownloadMenuLayout.top }
            : { bottom: exportDownloadMenuLayout.bottom }),
          }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
            onClick={() => {
              setExportDownloadMenuOpen(false);
              void downloadFromExportModal();
            }}
          >
            依目前選項下載（{exportFileFormat === "txt" ? "TXT" : "SRT"}）
          </button>
          <div className="my-1 h-px bg-border" aria-hidden />
          <button
            type="button"
            role="menuitem"
            className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
            onClick={() => {
              setExportDownloadMenuOpen(false);
              void saveExport(
                buildSrtBilingualStacked(segments),
                `${baseExportName}.bilingual.srt`,
                [{ name: "SRT", extensions: ["srt"] }],
              );
            }}
          >
            SRT 雙語單檔（另存）
          </button>
          <button
            type="button"
            role="menuitem"
            className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
            onClick={() => {
              setExportDownloadMenuOpen(false);
              void saveExport(
                buildSrtOriginal(segments),
                `${baseExportName}.原文.srt`,
                [{ name: "SRT", extensions: ["srt"] }],
              );
            }}
          >
            SRT 原文
          </button>
          <button
            type="button"
            role="menuitem"
            className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
            disabled={!hasAnyTranslation}
            onClick={() => {
              setExportDownloadMenuOpen(false);
              void saveExport(
                buildSrtTranslated(segments),
                `${baseExportName}.譯文.srt`,
                [{ name: "SRT", extensions: ["srt"] }],
              );
            }}
          >
            SRT 譯文
          </button>
          <button
            type="button"
            role="menuitem"
            className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
            disabled={!hasAnyTranslation}
            title="連續兩次另存：先原文、再譯文（兩條字幕軌）"
            onClick={async () => {
              setExportDownloadMenuOpen(false);
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
          >
            SRT 雙檔
          </button>
        </div>,
        document.body,
      )
    : null}
    </>
  );
}
