const fs = require("node:fs");
const path = require("node:path");
const { ipcMain, dialog } = require("electron");
const Database = require("better-sqlite3");
/** electron-store v9+ 為 ESM；CJS require 常得到 { default: class Store } */
const StoreModule = require("electron-store");
const Store = StoreModule.default ?? StoreModule;
const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");
const { translate } = require("@vitalets/google-translate-api");

/** @type {Database.Database | null} */
let db = null;

const settingsStore = new Store({
  name: "voice-translator-settings",
  defaults: {
    openaiApiKey: "",
    anthropicApiKey: "",
    summaryModel: "gpt-4o-mini",
    anthropicSummaryModel: "claude-sonnet-4-20250514",
    summaryProvider: "openai",
    translationModel: "gpt-4o-mini",
    /** faster-whisper：auto | cpu | cuda（CUDA 即 NVIDIA GPU） */
    whisperDevice: "auto",
  },
});

/** @returns {Record<string, string>} */
function getWhisperEnvForTranscribe() {
  const raw = settingsStore.get("whisperDevice");
  const v = raw === "cpu" || raw === "cuda" ? raw : "auto";
  return { WHISPER_DEVICE: v };
}

/**
 * @param {string} userDataPath
 */
function initDatabase(userDataPath) {
  if (db) return db;
  const dbPath = path.join(userDataPath, "voice-translator.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      media_path TEXT,
      media_name TEXT,
      summary_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS segments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      start REAL NOT NULL,
      end REAL NOT NULL,
      text TEXT NOT NULL,
      translated_text TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_segments_task ON segments(task_id, seq);
  `);
  return db;
}

function getDb() {
  if (!db) throw new Error("Database not initialized");
  return db;
}

/**
 * @param {() => import('electron').BrowserWindow | null} getMainWindow
 */
function registerExtraIpc(getMainWindow) {
  ipcMain.handle("settings:get", () => ({ ...settingsStore.store }));

  ipcMain.handle("settings:set", (_event, partial) => {
    if (!partial || typeof partial !== "object") return { ok: false };
    for (const [k, v] of Object.entries(partial)) {
      settingsStore.set(k, v);
    }
    return { ok: true };
  });

  ipcMain.handle("db:tasks:list", () => {
    const rows = getDb()
      .prepare(
        `SELECT id, name, media_path AS mediaPath, media_name AS mediaName, 
         summary_json AS summaryJson, created_at AS createdAt, updated_at AS updatedAt
         FROM tasks ORDER BY updated_at DESC LIMIT 200`,
      )
      .all();
    return rows;
  });

  ipcMain.handle("db:tasks:get", (_event, taskId) => {
    const task = getDb()
      .prepare(
        `SELECT id, name, media_path AS mediaPath, media_name AS mediaName, 
         summary_json AS summaryJson, created_at AS createdAt, updated_at AS updatedAt
         FROM tasks WHERE id = ?`,
      )
      .get(taskId);
    if (!task) return null;
    const segments = getDb()
      .prepare(
        `SELECT id, start, end, text, translated_text AS translatedText 
         FROM segments WHERE task_id = ? ORDER BY seq ASC`,
      )
      .all(taskId);
    return { task, segments };
  });

  ipcMain.handle("db:tasks:save", (_event, payload) => {
    const {
      task,
      segments,
    } = payload;
    if (!task?.id || !task?.name) return { ok: false, error: "缺少任務 id 或名稱" };
    const now = Date.now();
    const tx = getDb().transaction(() => {
      getDb()
        .prepare(
          `INSERT INTO tasks (id, name, media_path, media_name, summary_json, created_at, updated_at)
           VALUES (@id, @name, @media_path, @media_name, @summary_json, @created_at, @updated_at)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             media_path = excluded.media_path,
             media_name = excluded.media_name,
             summary_json = excluded.summary_json,
             updated_at = excluded.updated_at`,
        )
        .run({
          id: task.id,
          name: task.name,
          media_path: task.mediaPath ?? null,
          media_name: task.mediaName ?? null,
          summary_json:
            typeof task.summaryJson === "string"
              ? task.summaryJson
              : task.summaryJson
                ? JSON.stringify(task.summaryJson)
                : null,
          created_at: task.createdAt ?? now,
          updated_at: now,
        });

      getDb().prepare("DELETE FROM segments WHERE task_id = ?").run(task.id);

      const ins = getDb().prepare(
        `INSERT INTO segments (id, task_id, seq, start, end, text, translated_text)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      (segments || []).forEach((s, i) => {
        ins.run(
          s.id,
          task.id,
          i,
          s.start,
          s.end,
          s.text,
          s.translatedText ?? null,
        );
      });
    });
    tx();
    return { ok: true };
  });

  ipcMain.handle("db:tasks:delete", (_event, taskId) => {
    getDb().prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    return { ok: true };
  });

  ipcMain.handle("fs:saveText", async (_event, opts) => {
    const win = getMainWindow();
    if (!win) return { ok: false, error: "無視窗" };
    const { content, defaultName, filters } = opts || {};
    const r = await dialog.showSaveDialog(win, {
      defaultPath: defaultName || "export",
      filters: filters || [{ name: "純文字", extensions: ["txt"] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, content ?? "", "utf8");
    return { ok: true, path: r.filePath };
  });

  ipcMain.handle(
    "ai:summarize",
    async (_event, { transcript, provider }) => {
      const text = String(transcript || "").trim();
      if (!text) return { ok: false, error: "沒有逐字稿可摘要" };

      const promptBase = `你是專業的會議紀錄助理。以下是繁體或各語言的逐字稿。請輸出**僅一個** JSON 物件（不要 markdown 或程式碼區塊），鍵名固定為：
{"title":"字串","bulletPoints":["字串",...],"actionItems":["字串",...]}
title 為簡短標題；bulletPoints 為 3–10 條重點；actionItems 為具體待辦（若無則空陣列）。使用繁體中文。

逐字稿：
${text.slice(0, 120000)}`;

      const parseSummaryJson = (raw) => {
        if (!raw || typeof raw !== "string") return null;
        let t = raw.trim();
        if (t.startsWith("```")) {
          t = t
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```\s*$/, "");
        }
        try {
          const parsed = JSON.parse(t);
          return {
            title: String(parsed.title || ""),
            bulletPoints: Array.isArray(parsed.bulletPoints)
              ? parsed.bulletPoints.map(String)
              : [],
            actionItems: Array.isArray(parsed.actionItems)
              ? parsed.actionItems.map(String)
              : [],
          };
        } catch {
          return null;
        }
      };

      const wantAnthropic =
        provider === "anthropic" ?
          true
        : provider === "openai" ?
          false
        : settingsStore.get("summaryProvider") === "anthropic";

      if (wantAnthropic) {
        const akey = settingsStore.get("anthropicApiKey");
        if (!akey || typeof akey !== "string") {
          return {
            ok: false,
            error: "請在設置中填寫 Anthropic API Key",
          };
        }
        const model =
          settingsStore.get("anthropicSummaryModel") ||
          "claude-sonnet-4-20250514";
        const client = new Anthropic({ apiKey: akey });
        try {
          const res = await client.messages.create({
            model,
            max_tokens: 4096,
            messages: [{ role: "user", content: promptBase }],
          });
          const block = res.content[0];
          const raw =
            block && block.type === "text" ? block.text : "";
          if (!raw) return { ok: false, error: "API 未回傳內容" };
          const summary = parseSummaryJson(raw);
          if (!summary) return { ok: false, error: "無法解析 JSON" };
          return { ok: true, summary };
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }

      const key = settingsStore.get("openaiApiKey");
      if (!key || typeof key !== "string") {
        return { ok: false, error: "請在設置中填寫 OpenAI API Key" };
      }
      const model = settingsStore.get("summaryModel") || "gpt-4o-mini";
      const client = new OpenAI({ apiKey: key });
      try {
        const res = await client.chat.completions.create({
          model,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: promptBase }],
        });
        const raw = res.choices[0]?.message?.content;
        if (!raw) return { ok: false, error: "API 未回傳內容" };
        const summary = parseSummaryJson(raw);
        if (!summary) return { ok: false, error: "無法解析 JSON" };
        return { ok: true, summary };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  );

  ipcMain.handle("ai:translateGoogle", async (_event, { segments, target }) => {
    const to = String(target || "zh-TW");
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const results = [];
    for (const seg of segments || []) {
      if (!seg?.text) {
        results.push({ id: seg.id, text: "" });
        continue;
      }
      try {
        const { text } = await translate(String(seg.text), {
          to,
          from: "auto",
        });
        results.push({ id: seg.id, text: text || "" });
      } catch (e) {
        results.push({
          id: seg.id,
          text: "",
          error: e instanceof Error ? e.message : String(e),
        });
      }
      await delay(280);
    }
    return { ok: true, results };
  });

  ipcMain.handle("ai:translateOpenAI", async (_event, { segments, target }) => {
    const key = settingsStore.get("openaiApiKey");
    if (!key) {
      return { ok: false, error: "請在設置中填寫 OpenAI API Key" };
    }
    const model =
      settingsStore.get("translationModel") || "gpt-4o-mini";
    const langLabel =
      target === "ja"
        ? "日文"
        : target === "en"
          ? "英文"
          : "繁體中文";
    const client = new OpenAI({ apiKey: key });
    const list = segments || [];
    const results = [];
    const batchSize = 8;
    try {
      for (let i = 0; i < list.length; i += batchSize) {
        const batch = list.slice(i, i + batchSize);
        const payload = batch.map((s, j) => `${j + 1}. ${s.text}`).join("\n");
        const res = await client.chat.completions.create({
          model,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: `將以下每一行翻譯成${langLabel}，保持行順序與數量不變。輸出 JSON：{"lines":["譯文1","譯文2",...]}

${payload}`,
            },
          ],
        });
        const raw = res.choices[0]?.message?.content;
        const parsed = raw ? JSON.parse(raw) : null;
        const lines = Array.isArray(parsed?.lines)
          ? parsed.lines
          : [];
        batch.forEach((s, j) => {
          results.push({
            id: s.id,
            text: String(lines[j] ?? ""),
          });
        });
      }
      return { ok: true, results };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
}

module.exports = { initDatabase, registerExtraIpc, getWhisperEnvForTranscribe };
