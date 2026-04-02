"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type WhisperDevice = "auto" | "cpu" | "cuda";

export default function SettingsPage() {
  const [openaiKey, setOpenaiKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [summaryProvider, setSummaryProvider] = useState<"openai" | "anthropic">(
    "openai",
  );
  const [summaryModel, setSummaryModel] = useState("gpt-4o-mini");
  const [anthropicSummaryModel, setAnthropicSummaryModel] = useState(
    "claude-sonnet-4-20250514",
  );
  const [translationModel, setTranslationModel] = useState("gpt-4o-mini");
  const [whisperDevice, setWhisperDevice] = useState<WhisperDevice>("auto");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      if (!window.electronAPI?.settingsGet) return;
      const s = await window.electronAPI.settingsGet();
      setOpenaiKey(String(s.openaiApiKey ?? ""));
      setAnthropicKey(String(s.anthropicApiKey ?? ""));
      setSummaryModel(String(s.summaryModel ?? "gpt-4o-mini"));
      setAnthropicSummaryModel(
        String(s.anthropicSummaryModel ?? "claude-sonnet-4-20250514"),
      );
      setTranslationModel(String(s.translationModel ?? "gpt-4o-mini"));
      const wd = String(s.whisperDevice ?? "auto");
      if (wd === "cpu" || wd === "cuda") setWhisperDevice(wd);
      else setWhisperDevice("auto");
      if (s.summaryProvider === "anthropic") setSummaryProvider("anthropic");
      else setSummaryProvider("openai");
    })();
  }, []);

  const save = async () => {
    if (!window.electronAPI?.settingsSet) return;
    await window.electronAPI.settingsSet({
      openaiApiKey: openaiKey,
      anthropicApiKey: anthropicKey,
      summaryProvider,
      summaryModel,
      anthropicSummaryModel,
      translationModel,
      whisperDevice,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/25">
      <div className="mx-auto w-full max-w-xl flex-1 space-y-6 overflow-y-auto p-6">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/"
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "gap-1.5 no-underline",
            )}
          >
            <ArrowLeft className="size-4" />
            返回工作區
          </Link>
        </div>

        <div>
          <h1 className="text-lg font-semibold">設置</h1>
          <p className="text-sm text-muted-foreground">
            API 金鑰僅儲存在本機（Electron userData）；音檔轉錄仍在本機
            Whisper，不上傳雲端。
          </p>
        </div>

        <Card className="space-y-4 p-6">
          <div className="space-y-2">
            <Label htmlFor="whisper-device">本機轉錄裝置（Whisper）</Label>
            <select
              id="whisper-device"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              value={whisperDevice}
              onChange={(e) =>
                setWhisperDevice(e.target.value as WhisperDevice)
              }
            >
              <option value="auto">
                自動（偵測到 NVIDIA CUDA 時用 GPU，否則 CPU）
              </option>
              <option value="cpu">CPU</option>
              <option value="cuda">CUDA（NVIDIA 顯示卡／GPU）</option>
            </select>
            <p className="text-xs text-muted-foreground">
              本程式使用 faster-whisper：在 Windows 上透過 NVIDIA CUDA 使用獨顯。選「CUDA」前請確認已安裝支援
              GPU 的 PyTorch（例如 CUDA 版）；若僅 CPU 版 PyTorch，請選「CPU」或「自動」。
            </p>
          </div>
        </Card>

        <Card className="space-y-4 p-6">
          <div className="space-y-2">
            <Label htmlFor="openai">OpenAI API Key</Label>
            <Input
              id="openai"
              type="password"
              autoComplete="off"
              placeholder="sk-..."
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              用於 OpenAI 摘要／翻譯。只會送出逐字**文字**。
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="anthropic">Anthropic API Key</Label>
            <Input
              id="anthropic"
              type="password"
              autoComplete="off"
              placeholder="sk-ant-..."
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              用於 Claude 摘要（與 OpenAI 擇一或並用於工作區手動切換）。
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="sum-prov">預設一鍵總結引擎</Label>
            <select
              id="sum-prov"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              value={summaryProvider}
              onChange={(e) =>
                setSummaryProvider(e.target.value as "openai" | "anthropic")
              }
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic Claude</option>
            </select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="sum-model">OpenAI 摘要模型</Label>
              <Input
                id="sum-model"
                value={summaryModel}
                onChange={(e) => setSummaryModel(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="claude-sum">Claude 摘要模型</Label>
              <Input
                id="claude-sum"
                value={anthropicSummaryModel}
                onChange={(e) => setAnthropicSummaryModel(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tr-model">翻譯模型（OpenAI）</Label>
            <Input
              id="tr-model"
              value={translationModel}
              onChange={(e) => setTranslationModel(e.target.value)}
            />
          </div>

          <Button type="button" onClick={save}>
            {saved ? "已儲存" : "儲存設定"}
          </Button>
        </Card>
      </div>
    </div>
  );
}
