const { app, BrowserWindow, ipcMain, dialog, session, protocol } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

/** 供 http(s) 頁面載入本機影片／音訊；file:// 在 localhost 內嵌媒體常被擋 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: "media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
const { spawn } = require("node:child_process");
const {
  initDatabase,
  registerExtraIpc,
  getWhisperEnvForTranscribe,
} = require("./ipc-extra.cjs");
const {
  getPythonSpawnConfig,
  listWindowsPythonCandidates,
} = require("./python-locate.cjs");

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {import('node:child_process').ChildProcess | null} */
let pythonProcess = null;

const isDev =
  process.env.NODE_ENV === "development" || !app.isPackaged;

function getPythonServicePaths() {
  if (app.isPackaged) {
    const root = process.resourcesPath;
    return {
      scriptPath: path.join(root, "python_service", "transcribe.py"),
      cwd: root,
    };
  }
  return {
    scriptPath: path.join(__dirname, "..", "python_service", "transcribe.py"),
    cwd: path.join(__dirname, ".."),
  };
}

function getStaticIndexHtml() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "out", "index.html");
  }
  return path.join(__dirname, "..", "out", "index.html");
}

/**
 * 內嵌 YouTube iframe 時，Chromium 會對子框架做權限檢查／請求；未處理時常出現灰畫面或無法播放。
 * 本機頁（localhost / file）仍放行 media／fullscreen，避免拖入檔案預覽被誤擋。
 */
function setupSessionForMediaEmbeds() {
  const sess = session.defaultSession;

  const isYoutubeRelated = (url) => {
    const s = String(url || "").toLowerCase();
    return (
      s.includes("youtube.com") ||
      s.includes("youtube-nocookie.com") ||
      s.includes("googlevideo.com") ||
      s.includes("google.com") ||
      s.includes("gstatic.com")
    );
  };

  const isLocalApp = (url) => {
    const s = String(url || "");
    return (
      s.startsWith("http://127.0.0.1") ||
      s.startsWith("http://localhost") ||
      s.startsWith("file://") ||
      s.startsWith("media://") ||
      s === "null" ||
      s === ""
    );
  };

  sess.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (isYoutubeRelated(requestingOrigin) || isLocalApp(requestingOrigin)) {
      return true;
    }
    return false;
  });

  sess.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const reqUrl =
      details && typeof details === "object" && "requestingUrl" in details ?
        details.requestingUrl
      : "";
    if (isYoutubeRelated(reqUrl) || isLocalApp(reqUrl)) {
      callback(true);
      return;
    }
    callback(false);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "語音辨識與翻譯",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 允許從 http://localhost 載入的頁面播放本機 file:// 媒體（僅建議用於本機工具）
      webSecurity: false,
    },
  });

  if (isDev) {
    const devUrl = process.env.ELECTRON_DEV_SERVER_URL || "http://127.0.0.1:3000";
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(getStaticIndexHtml());
  }
}

function broadcastTranscribe(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("transcribe:event", payload);
  }
}

ipcMain.handle("media:fileUrl", (_event, filePath) => {
  if (typeof filePath !== "string" || !filePath) return null;
  try {
    const normalized = path.normalize(filePath);
    if (!fs.existsSync(normalized)) return null;
    const q = encodeURIComponent(normalized);
    return `media://local/?f=${q}`;
  } catch {
    return null;
  }
});

function registerMediaFileProtocol() {
  protocol.registerFileProtocol("media", (request, callback) => {
    try {
      const u = new URL(request.url);
      const qp = u.searchParams.get("f");
      if (!qp) {
        callback({ error: -6 });
        return;
      }
      const filepath = path.normalize(decodeURIComponent(qp));
      if (!fs.existsSync(filepath)) {
        callback({ error: -6 });
        return;
      }
      callback({ path: filepath });
    } catch {
      callback({ error: -2 });
    }
  });
}

ipcMain.handle("dialog:openFile", async () => {
  if (!mainWindow) return null;
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      {
        name: "音訊／影片",
        extensions: ["mp4", "mkv", "webm", "mov", "mp3", "wav", "m4a"],
      },
      { name: "所有檔案", extensions: ["*"] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

ipcMain.handle("transcribe:start", async (_event, filePath) => {
  if (pythonProcess) {
    try {
      pythonProcess.kill();
    } catch {
      /* ignore */
    }
    pythonProcess = null;
  }

  const { scriptPath, cwd: pyCwd } = getPythonServicePaths();
  const pyCfg = getPythonSpawnConfig();

  if (process.platform === "win32") {
    const listed = listWindowsPythonCandidates();
    const hasCustom = Boolean(
      (
        process.env.VOICE_TRANSLATOR_PYTHON ||
        process.env.PYTHON_EXECUTABLE ||
        process.env.PYTHON
      )?.trim(),
    );
    if (
      listed.length > 0 &&
      !listed.some((c) => c.ok) &&
      !hasCustom &&
      (pyCfg.cmd === "py" || pyCfg.cmd === "python")
    ) {
      return {
        ok: false,
        error:
          "已找到的 Python 不完整（缺少 Lib\\encodings 等標準函式庫）。請至 https://www.python.org/downloads/ 重新安裝並勾選 Add to PATH，或另裝一份 Python 3.12+；然後在專案目錄執行 npm run setup:python，並重新啟動本程式。",
      };
    }
  }

  const { cmd: pyCmd, argsPrefix, pythonHome } = pyCfg;
  const args = [...argsPrefix, scriptPath, "--input", filePath];

  try {
    const pyEnv = {
      ...process.env,
      ...getWhisperEnvForTranscribe(),
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

    pythonProcess = spawn(pyCmd, args, {
      cwd: pyCwd,
      env: pyEnv,
    });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  let buffer = "";
  let stderrBuf = "";

  function parseStdoutLine(raw) {
    const t = (raw || "").trim();
    if (!t) return;
    try {
      const msg = JSON.parse(t);
      broadcastTranscribe(msg);
    } catch {
      broadcastTranscribe({
        type: "error",
        message: `無效輸出行: ${t.slice(0, 200)}`,
      });
    }
  }

  /** 程序結束時 stdout 最後一行可能沒有 \\n，若不 flush 會遺失 JSON 錯誤訊息 */
  function flushStdoutRemainder() {
    const tail = buffer.trim();
    buffer = "";
    if (tail) parseStdoutLine(tail);
  }

  pythonProcess.stdout?.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      parseStdoutLine(line);
    }
  });

  pythonProcess.stdout?.on("end", () => {
    flushStdoutRemainder();
  });

  pythonProcess.stderr?.on("data", (d) => {
    const t = d.toString("utf8");
    stderrBuf += t;
    if (stderrBuf.length > 12000) {
      stderrBuf = stderrBuf.slice(-12000);
    }
    if (process.env.TRANSCRIBE_DEBUG) {
      console.error("[python stderr]", t);
    }
  });

  pythonProcess.on("close", (code) => {
    flushStdoutRemainder();
    const exitCode = code ?? 0;
    if (exitCode !== 0) {
      const errText = stderrBuf.trim();
      if (errText) {
        console.error("[transcribe python stderr]", errText.slice(0, 4000));
        let sentFromJson = false;
        for (const line of errText.split("\n")) {
          const t = line.trim();
          if (!t.startsWith("{")) continue;
          try {
            const msg = JSON.parse(t);
            if (
              msg &&
              typeof msg === "object" &&
              typeof msg.type === "string"
            ) {
              broadcastTranscribe(msg);
              sentFromJson = true;
            }
          } catch {
            /* 非 JSON 行略過 */
          }
        }
        if (!sentFromJson) {
          broadcastTranscribe({
            type: "error",
            message: `Python／程式庫訊息（stderr）：\n${errText.slice(0, 6000)}`,
          });
        }
      }
    }
    broadcastTranscribe({ type: "done", code: exitCode });
    pythonProcess = null;
  });

  pythonProcess.on("error", (err) => {
    const hint =
      process.platform === "win32" ?
        `請在專案目錄執行 npm run setup:python 檢查安裝並安裝 faster-whisper；若顯示標準函式庫異常，請到 python.org 重新安裝 Python 並勾選完整安裝。亦可設定 VOICE_TRANSLATOR_PYTHON 指向有效的 python.exe。`
      : `請確認已安裝 python3，並執行：cd python_service && pip install -r requirements.txt`;
    broadcastTranscribe({
      type: "error",
      message: `無法啟動 Python：${err.message}。${hint}`,
    });
    pythonProcess = null;
  });

  return { ok: true };
});

ipcMain.handle("transcribe:cancel", async () => {
  if (pythonProcess) {
    try {
      pythonProcess.kill();
    } catch {
      /* ignore */
    }
    pythonProcess = null;
  }
  return { ok: true };
});

app.whenReady().then(() => {
  registerMediaFileProtocol();
  setupSessionForMediaEmbeds();
  initDatabase(app.getPath("userData"));
  createWindow();
  registerExtraIpc(() => mainWindow);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (pythonProcess) {
    try {
      pythonProcess.kill();
    } catch {
      /* ignore */
    }
  }
  if (process.platform !== "darwin") app.quit();
});
