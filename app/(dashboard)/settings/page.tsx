"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ANTHROPIC_SUMMARY_MODEL_OPTIONS,
  GEMINI_SUMMARY_MODEL_OPTIONS,
  OPENAI_SUMMARY_MODEL_OPTIONS,
  TRANSLATION_MODEL_OPTIONS,
  selectOptionsWithCurrent,
} from "@/lib/llm-model-options";

type WhisperDevice = "auto" | "cpu" | "cuda";

type LlmKeyProvider = "openai" | "anthropic" | "gemini";

type SummaryProvider = "openai" | "anthropic" | "gemini";

export default function SettingsPage() {
  const [openaiKey, setOpenaiKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [llmKeyProvider, setLlmKeyProvider] = useState<LlmKeyProvider>("openai");
  const [summaryProvider, setSummaryProvider] = useState<SummaryProvider>(
    "openai",
  );
  const [summaryModel, setSummaryModel] = useState("gpt-4o-mini");
  const [anthropicSummaryModel, setAnthropicSummaryModel] = useState(
    "claude-sonnet-4-20250514",
  );
  const [geminiSummaryModel, setGeminiSummaryModel] = useState(
    "gemini-2.0-flash",
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
      setGeminiKey(String(s.geminiApiKey ?? ""));
      setSummaryModel(String(s.summaryModel ?? "gpt-4o-mini"));
      setAnthropicSummaryModel(
        String(s.anthropicSummaryModel ?? "claude-sonnet-4-20250514"),
      );
      setGeminiSummaryModel(
        String(s.geminiSummaryModel ?? "gemini-2.0-flash"),
      );
      setTranslationModel(String(s.translationModel ?? "gpt-4o-mini"));
      const wd = String(s.whisperDevice ?? "auto");
      if (wd === "cpu" || wd === "cuda") setWhisperDevice(wd);
      else setWhisperDevice("auto");
      const sp = String(s.summaryProvider ?? "openai");
      if (sp === "anthropic") setSummaryProvider("anthropic");
      else if (sp === "gemini") setSummaryProvider("gemini");
      else setSummaryProvider("openai");
      setHuggingfaceToken(String(s.huggingfaceToken ?? ""));
    })();
  }, []);

  const save = async () => {
    if (!window.electronAPI?.settingsSet) return;
    await window.electronAPI.settingsSet({
      openaiApiKey: openaiKey,
      anthropicApiKey: anthropicKey,
      geminiApiKey: geminiKey,
      summaryProvider,
      summaryModel,
      anthropicSummaryModel,
      geminiSummaryModel,
      translationModel,
      whisperDevice,
      huggingfaceToken,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const setActiveApiKey = (v: string) => {
    if (llmKeyProvider === "openai") setOpenaiKey(v);
    else if (llmKeyProvider === "anthropic") setAnthropicKey(v);
    else setGeminiKey(v);
  };

  const activeApiKey =
    llmKeyProvider === "openai" ?
      openaiKey
    : llmKeyProvider === "anthropic" ?
      anthropicKey
    : geminiKey;

  const inputSelectClass =
    "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/25">
      <div className="no-scrollbar mx-auto w-full max-w-6xl flex-1 space-y-6 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
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

        <div className="max-w-3xl">
          <h1 className="text-lg font-semibold">設置</h1>
          <p className="text-pretty text-sm text-muted-foreground">
            API 金鑰僅儲存在本機（Electron userData）；音檔轉錄仍在本機
            Whisper，不上傳雲端。
          </p>
        </div>

        <Card className="p-5 sm:p-6 lg:p-8">
          <div className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="whisper-device">本機轉錄裝置（Whisper）</Label>
              <select
                id="whisper-device"
                className={inputSelectClass}
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
              <p className="text-pretty text-xs text-muted-foreground">
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
              <p className="text-pretty text-xs text-muted-foreground">
                用於本機 pyannote
                模型下載與辨識；僅存於本機。請至 Hugging Face 申請帳號並接受
                pyannote/speaker-diarization-3.1 等模型使用條款，另請安裝{" "}
                <code className="rounded bg-muted px-0.5">
                  requirements-speaker.txt
                </code>
                。
              </p>
            </div>

            <div className="space-y-3">
              <div className="space-y-2">
                <p className="text-sm font-medium leading-none">LLM API 金鑰</p>
                <p className="text-pretty text-xs text-muted-foreground">
                  以「供應商」切換要編輯的帳戶；三邊可各存一把金鑰。摘要／翻譯僅送出逐字**文字**。
                </p>
                <div className="flex flex-col gap-3 sm:max-w-xl sm:flex-row sm:items-end sm:gap-3">
                  <div className="w-full min-w-0 space-y-2 sm:max-w-[200px]">
                    <Label
                      htmlFor="llm-key-provider"
                      className="text-xs font-normal text-muted-foreground"
                    >
                      供應商
                    </Label>
                    <select
                      id="llm-key-provider"
                      className={inputSelectClass}
                      value={llmKeyProvider}
                      onChange={(e) =>
                        setLlmKeyProvider(e.target.value as LlmKeyProvider)
                      }
                    >
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="gemini">Google Gemini</option>
                    </select>
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    <Label
                      htmlFor="llm-api-key"
                      className="text-xs font-normal text-muted-foreground"
                    >
                      API Key
                    </Label>
                    <Input
                      id="llm-api-key"
                      type="password"
                      autoComplete="off"
                      placeholder={
                        llmKeyProvider === "openai" ? "sk-…"
                        : llmKeyProvider === "anthropic" ? "sk-ant-…"
                        : "Google AI（AIza…）"
                      }
                      value={activeApiKey}
                      onChange={(e) => setActiveApiKey(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-2 lg:gap-8">
              <div className="space-y-2">
                <Label htmlFor="sum-prov">預設一鍵總結引擎</Label>
                <select
                  id="sum-prov"
                  className={inputSelectClass}
                  value={summaryProvider}
                  onChange={(e) =>
                    setSummaryProvider(e.target.value as SummaryProvider)
                  }
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic Claude</option>
                  <option value="gemini">Google Gemini</option>
                </select>
                <p className="text-pretty text-xs text-muted-foreground">
                  工作區「一鍵總結」預設使用的後端；三家 API 金鑰可同時設定。
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="tr-model">翻譯模型</Label>
                <select
                  id="tr-model"
                  className={inputSelectClass}
                  value={translationModel}
                  onChange={(e) => setTranslationModel(e.target.value)}
                >
                  {selectOptionsWithCurrent(
                    TRANSLATION_MODEL_OPTIONS,
                    translationModel,
                  ).map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
                <p className="text-pretty text-xs text-muted-foreground">
                  以 OpenAI 引擎翻譯時用上方 OpenAI
                  模型；選擇 gemini- 開頭的 id 則走 Google Gemini API。
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 sm:gap-5 lg:gap-6">
              <div className="space-y-2">
                <Label htmlFor="sum-model">OpenAI 摘要模型</Label>
                <select
                  id="sum-model"
                  className={inputSelectClass}
                  value={summaryModel}
                  onChange={(e) => setSummaryModel(e.target.value)}
                >
                  {selectOptionsWithCurrent(
                    OPENAI_SUMMARY_MODEL_OPTIONS,
                    summaryModel,
                  ).map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="claude-sum">Claude 摘要模型</Label>
                <select
                  id="claude-sum"
                  className={inputSelectClass}
                  value={anthropicSummaryModel}
                  onChange={(e) => setAnthropicSummaryModel(e.target.value)}
                >
                  {selectOptionsWithCurrent(
                    ANTHROPIC_SUMMARY_MODEL_OPTIONS,
                    anthropicSummaryModel,
                  ).map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2 sm:col-span-2 lg:col-span-1">
                <Label htmlFor="gemini-sum">Gemini 摘要模型</Label>
                <select
                  id="gemini-sum"
                  className={inputSelectClass}
                  value={geminiSummaryModel}
                  onChange={(e) => setGeminiSummaryModel(e.target.value)}
                >
                  {selectOptionsWithCurrent(
                    GEMINI_SUMMARY_MODEL_OPTIONS,
                    geminiSummaryModel,
                  ).map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="pt-1">
              <Button type="button" onClick={save} className="w-full sm:w-auto">
                {saved ? "已儲存" : "儲存設定"}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
