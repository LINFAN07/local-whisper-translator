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
  const [huggingfaceToken, setHuggingfaceToken] = useState("");
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
      setHuggingfaceToken(String(s.huggingfaceToken ?? ""));
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
      huggingfaceToken,
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
                自動（CTranslate2 偵測到 CUDA 時用 GPU，否則 CPU）
              </option>
              <option value="cpu">CPU</option>
              <option value="cuda">CUDA（NVIDIA 顯示卡／GPU）</option>
            </select>
            <p className="text-xs text-muted-foreground">
              使用 faster-whisper（CTranslate2）。Windows GPU：請執行{" "}
              <code className="rounded bg-muted px-1">npm run setup:python</code>{" "}
              以安裝{" "}
              <code className="rounded bg-muted px-1">
                requirements-cuda-windows.txt
              </code>
              （cuBLAS／cuDNN）；或手動{" "}
              <code className="rounded bg-muted px-1">
                pip install -r python_service/requirements-cuda-windows.txt
              </code>
              。亦需 NVIDIA 驅動。不必為轉錄另外安裝 PyTorch。
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="hf-token">Hugging Face Token（說話人識別選用）</Label>
            <Input
              id="hf-token"
              type="password"
              autoComplete="off"
              placeholder="hf_..."
              value={huggingfaceToken}
              onChange={(e) => setHuggingfaceToken(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              用於本機 pyannote
              模型下載與辨識；僅存於本機。請至 Hugging Face 申請帳號並接受
              pyannote/speaker-diarization-3.1 等模型使用條款，另請安裝{" "}
              <code className="rounded bg-muted px-0.5">
                requirements-speaker.txt
              </code>
              。
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
