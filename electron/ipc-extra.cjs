const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ipcMain, dialog, app, clipboard } = require("electron");
const { getPythonSpawnConfig } = require("./python-locate.cjs");
const Database = require("better-sqlite3");
/** electron-store v9+ 為 ESM；CJS require 常得到 { default: class Store } */
const StoreModule = require("electron-store");
const Store = StoreModule.default ?? StoreModule;
const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");
const { translate } = require("@vitalets/google-translate-api");

/** @type {Database.Database | null} */
let db = null;

/** @type {import('node:child_process').ChildProcess | null} */
let speakerAssignProcess = null;

const settingsStore = new Store({
  name: "voice-translator-settings",
  defaults: {
    openaiApiKey: "",
    anthropicApiKey: "",
    summaryModel: "gpt-4o-mini",
    anthropicSummaryModel: "claude-sonnet-4-20250514",
    summaryProvider: "openai",
    translationModel: "gpt-4o-mini",
    /** faster-whisper／CTranslate2：auto | cpu | cuda */
    whisperDevice: "auto",
    /** Hugging Face token（說話人分離 pyannote 用），僅存本機 */
    huggingfaceToken: "",
  },
});

/** @returns {Record<string, string>} */
function getWhisperEnvForTranscribe() {
  const raw = settingsStore.get("whisperDevice");
  const v = raw === "cpu" || raw === "cuda" ? raw : "auto";
  return { WHISPER_DEVICE: v };
}

/** 供說話人識別子進程：合併本機 HF 權杖至環境（不變更全域 process.env） */
function getSpeakerAssignEnv() {
  const token = String(settingsStore.get("huggingfaceToken") ?? "").trim();
  const env = { ...process.env };
  if (token) env.HF_TOKEN = token;
  return env;
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
  const segCols = db.prepare("PRAGMA table_info(segments)").all();
  const hasSpeaker = segCols.some((c) => c.name === "speaker");
  if (!hasSpeaker) {
    db.exec("ALTER TABLE segments ADD COLUMN speaker TEXT");
  }
  return db;
}

function getDb() {
  if (!db) throw new Error("Database not initialized");
  return db;
}

function getAssignSpeakersPaths() {
  if (app.isPackaged) {
    const root = process.resourcesPath;
    return {
      scriptPath: path.join(root, "python_service", "assign_speakers.py"),
      cwd: root,
    };
  }
  return {
    scriptPath: path.join(__dirname, "..", "python_service", "assign_speakers.py"),
    cwd: path.join(__dirname, ".."),
  };
}

function killSpeakerAssignProcess() {
  if (speakerAssignProcess) {
    try {
      speakerAssignProcess.kill();
    } catch {
      /* ignore */
    }
    speakerAssignProcess = null;
  }
}

/** 分塊寫入剪貼簿時暫存（避免單次 IPC 字串過大導致主程序序列化失敗） */
const clipboardChunkPending = new Map();

function clearClipboardChunkPending(id) {
  const p = clipboardChunkPending.get(id);
  if (p?.timer) clearTimeout(p.timer);
  clipboardChunkPending.delete(id);
}

/**
 * 與 main.cjs 頂層 IPC 相同，在模組載入時即註冊，避免僅在 app.whenReady 內註冊時出現
 * 「頁面已載入但 handler 尚未掛上」或 ready 鏈中斷導致 No handler registered。
 */
function registerClipboardIpcHandlers() {
  ipcMain.handle("clipboard:writeText", (_event, text) => {
    try {
      clipboard.writeText(String(text ?? ""));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle("clipboard:writeTextChunk", (_event, payload) => {
    const id = payload && typeof payload.id === "string" ? payload.id : "";
    if (!id) return { ok: false, error: "invalid clipboard chunk id" };
    try {
      let entry = clipboardChunkPending.get(id);
      if (!entry) {
        entry = {
          acc: "",
          timer: setTimeout(() => clearClipboardChunkPending(id), 120_000),
        };
        clipboardChunkPending.set(id, entry);
      }
      entry.acc += String(payload.chunk ?? "");
      if (payload.last) {
        const full = entry.acc;
        clearClipboardChunkPending(id);
        clipboard.writeText(full);
        return { ok: true };
      }
      return { ok: true };
    } catch (e) {
      clearClipboardChunkPending(id);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle("clipboard:writeTextChunkCancel", (_event, chunkId) => {
    if (chunkId && typeof chunkId === "string") {
      clearClipboardChunkPending(chunkId);
    }
    return { ok: true };
  });
}

registerClipboardIpcHandlers();

/** 批次內分段，盡量避免出現在一般字幕內；輸出若被服務端剝除會改為逐段重試 */
const GOOGLE_TRANSLATE_BATCH_SEP = "\uE000";

/**
 * @param {string} s
 */
function normalizeForGoogleTranslateBatch(s) {
  return String(s || "")
    .replace(/\r?\n/g, " ")
    .replace(/\uE000/g, " ")
    .trim();
}

/**
 * 使用 @vitalets/google-translate-api：以批次減少請求、遇錯重試，降低限流與大量失敗。
 * @param {Array<{ id: unknown, text?: string }>} segments
 * @param {string} to
 */
async function translateSegmentsWithGoogleFreeApi(segments, to) {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const MAX_BATCH_LINES = 12;
  const MAX_BATCH_CHARS = 3000;
  const BETWEEN_BATCH_MS = 600;
  const BETWEEN_SINGLE_MS = 420;

  async function translateWithRetry(execute) {
    const maxAttempts = 4;
    const baseMs = 900;
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await execute();
      } catch (e) {
        lastErr = e;
        if (attempt < maxAttempts - 1) await delay(baseMs * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  async function oneCall(text) {
    const { text: out } = await translateWithRetry(() =>
      translate(text, { to, from: "auto" }),
    );
    return out || "";
  }

  const pushError = (results, id, err) => {
    results.push({
      id,
      text: "",
      error: err instanceof Error ? err.message : String(err),
    });
  };

  const list = Array.isArray(segments) ? segments : [];
  const results = [];
  let i = 0;

  while (i < list.length) {
    const seg = list[i];
    const raw = String(seg?.text ?? "");
    if (!raw.trim()) {
      results.push({ id: seg.id, text: "" });
      i++;
      continue;
    }

    const batch = [];
    let chars = 0;
    while (i < list.length && batch.length < MAX_BATCH_LINES) {
      const s = list[i];
      const r = String(s?.text ?? "");
      if (!r.trim()) break;

      const norm = normalizeForGoogleTranslateBatch(r);
      if (!norm) {
        results.push({ id: s.id, text: "" });
        i++;
        continue;
      }

      const extra = norm.length + (batch.length ? 1 : 0);
      if (batch.length && chars + extra > MAX_BATCH_CHARS) break;

      batch.push({ id: s.id, norm });
      chars += extra;
      i++;
    }

    if (batch.length === 0) continue;

    if (batch.length === 1) {
      const b = batch[0];
      try {
        const t = await oneCall(b.norm);
        results.push({ id: b.id, text: t });
      } catch (e) {
        pushError(results, b.id, e);
      }
      await delay(BETWEEN_SINGLE_MS);
      continue;
    }

    const joined = batch.map((b) => b.norm).join(GOOGLE_TRANSLATE_BATCH_SEP);
    try {
      const outRaw = await oneCall(joined);
      const parts = String(outRaw).split(GOOGLE_TRANSLATE_BATCH_SEP);
      if (parts.length === batch.length) {
        for (let k = 0; k < batch.length; k++) {
          results.push({ id: batch[k].id, text: parts[k] ?? "" });
        }
      } else {
        for (const b of batch) {
          try {
            const t = await oneCall(b.norm);
            results.push({ id: b.id, text: t });
          } catch (e) {
            pushError(results, b.id, e);
          }
          await delay(BETWEEN_SINGLE_MS);
        }
      }
    } catch (e) {
      for (const b of batch) {
        try {
          const t = await oneCall(b.norm);
          results.push({ id: b.id, text: t });
        } catch (e2) {
          pushError(results, b.id, e2);
        }
        await delay(BETWEEN_SINGLE_MS);
      }
    }
    await delay(BETWEEN_BATCH_MS);
  }

  return results;
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
        `SELECT id, start, end, text, translated_text AS translatedText, speaker AS speaker
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
        `INSERT INTO segments (id, task_id, seq, start, end, text, translated_text, speaker)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
          s.speaker ?? null,
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
    try {
      const results = await translateSegmentsWithGoogleFreeApi(
        segments || [],
        to,
      );
      return { ok: true, results };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
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

  ipcMain.handle("speaker:assign", async (_event, body) => {
    const mediaPath =
      typeof body?.mediaPath === "string" ? body.mediaPath.trim() : "";
    const segments = body?.segments;
    if (!mediaPath || !fs.existsSync(mediaPath)) {
      return { ok: false, error: "找不到媒體檔，或路徑無效。" };
    }
    if (!Array.isArray(segments) || segments.length === 0) {
      return { ok: false, error: "沒有可對齊的段落。" };
    }
    if (speakerAssignProcess) {
      return { ok: false, error: "說話人識別已在執行中。" };
    }

    const payloadPath = path.join(
      os.tmpdir(),
      `voice-translator-spk-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    try {
      fs.writeFileSync(
        payloadPath,
        JSON.stringify({
          media_path: mediaPath,
          segments,
        }),
        "utf8",
      );
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    const { scriptPath, cwd: spkCwd } = getAssignSpeakersPaths();
    const pyCfg = getPythonSpawnConfig();
    const { cmd: pyCmd, argsPrefix, pythonHome } = pyCfg;
    const args = [...argsPrefix, scriptPath, "--payload", payloadPath];

    return await new Promise((resolve) => {
      let outBuf = "";
      let errBuf = "";
      const pyEnv = {
        ...getSpeakerAssignEnv(),
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
      };
      delete pyEnv.PYTHONPATH;
      if (pythonHome) {
        pyEnv.PYTHONHOME = pythonHome;
      } else {
        delete pyEnv.PYTHONHOME;
      }

      try {
        speakerAssignProcess = spawn(pyCmd, args, {
          cwd: spkCwd,
          env: pyEnv,
        });
      } catch (e) {
        try {
          fs.unlinkSync(payloadPath);
        } catch {
          /* ignore */
        }
        resolve({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
        return;
      }

      speakerAssignProcess.stdout?.on("data", (chunk) => {
        outBuf += chunk.toString("utf8");
      });
      speakerAssignProcess.stderr?.on("data", (chunk) => {
        errBuf += chunk.toString("utf8");
      });

      speakerAssignProcess.on("close", (code) => {
        speakerAssignProcess = null;
        try {
          fs.unlinkSync(payloadPath);
        } catch {
          /* ignore */
        }

        const tail = outBuf.trim();
        let parsed = null;
        const lines = tail.split("\n").map((l) => l.trim()).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            parsed = JSON.parse(lines[i]);
            if (parsed && typeof parsed === "object") break;
          } catch {
            parsed = null;
          }
        }

        if (parsed && parsed.ok === true && Array.isArray(parsed.updates)) {
          resolve({
            ok: true,
            updates: parsed.updates,
          });
          return;
        }

        const msg =
          (parsed && typeof parsed.error === "string" && parsed.error) ||
          (errBuf.trim() ? errBuf.trim().slice(0, 4000) : "") ||
          (code !== 0 && code !== null ? `程序結束代碼 ${code}` : "") ||
          "無法解析說話人識別結果";
        resolve({ ok: false, error: msg });
      });

      speakerAssignProcess.on("error", (err) => {
        speakerAssignProcess = null;
        try {
          fs.unlinkSync(payloadPath);
        } catch {
          /* ignore */
        }
        resolve({ ok: false, error: err.message });
      });
    });
  });
}

module.exports = {
  initDatabase,
  registerExtraIpc,
  registerClipboardIpcHandlers,
  getWhisperEnvForTranscribe,
  getSpeakerAssignEnv,
  killSpeakerAssignProcess,
};
