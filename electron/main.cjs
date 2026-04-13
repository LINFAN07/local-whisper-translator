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
const net = require("node:net");
const {
  initDatabase,
  registerExtraIpc,
  getWhisperEnvForTranscribe,
  killSpeakerAssignProcess,
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

/** 打包後雙擊啟動時常無終端機，stdout/stderr 可能已關閉；避免內部寫入觸發 EPIPE 等未捕獲例外 */
for (const streamName of ["stdout", "stderr"]) {
  const stream = process[streamName];
  if (stream && typeof stream.on === "function") {
    stream.on("error", () => {});
  }
}

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
 * 輪詢直到 Next dev 在該埠接受 TCP 連線。
 * 使用 net.connect 而非 http.get：避免 Windows／代理環境下 HTTP_PROXY 讓連 localhost 走代理而失敗。
 */
function waitForDevServer(urlString, maxWaitMs = 300000) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return Promise.resolve(false);
  }
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  const host = u.hostname || "127.0.0.1";
  const start = Date.now();
  return new Promise((resolve) => {
    const attempt = () => {
      if (Date.now() - start >= maxWaitMs) {
        resolve(false);
        return;
      }
      const socket = net.connect(
        { port, host, timeout: 4000 },
        () => {
          socket.destroy();
          resolve(true);
        },
      );
      socket.on("error", () => {
        setTimeout(attempt, 400);
      });
      socket.on("timeout", () => {
        socket.destroy();
        setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

function loadElectronWaitHtml(devUrl) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  const body = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"/><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"/><title>載入中</title><style>body{font-family:system-ui,Segoe UI,sans-serif;background:#0a0a0a;color:#fafafa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}p{max-width:28rem;line-height:1.6}</style></head><body><p>正在連線至開發伺服器<br/><strong>${esc(devUrl)}</strong><br/>連上後會立刻切到應用程式；首次編譯可能需數十秒。若仍無畫面請執行 <code style="background:#222;padding:2px 6px;border-radius:4px">npm run dev</code> 或 <code style="background:#222;padding:2px 6px;border-radius:4px">npm run electron:dev</code></p></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(body)}`;
}

function loadElectronErrorHtml(devUrl) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  const body = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"/><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"/><title>無法載入</title><style>body{font-family:system-ui,Segoe UI,sans-serif;background:#1a0505;color:#fecaca;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}p{max-width:28rem;line-height:1.6}code{background:#3f0f0f;padding:2px 6px;border-radius:4px}</style></head><body><p><strong>無法連線至</strong><br/>${esc(devUrl)}<br/><br/>請在專案目錄執行 <code>npm run electron:dev</code>（會一併啟動 Next 與本視窗），或另開終端機執行 <code>npm run dev</code> 讓開發伺服器在埠 3001 運行後，關閉本視窗並重新開啟應用程式。<br/><br/>若已啟動仍失敗，請檢查系統是否對 <code>127.0.0.1</code> 設了 HTTP 代理；開發時可將 <code>NO_PROXY</code> 設為 <code>127.0.0.1,localhost</code>。</p></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(body)}`;
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
    backgroundColor: "#0a0a0a",
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
    const devUrl =
      process.env.ELECTRON_DEV_SERVER_URL || "http://127.0.0.1:3001";
    void mainWindow.loadURL(loadElectronWaitHtml(devUrl));

    void (async () => {
      const ok = await waitForDevServer(devUrl);
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (!ok) {
        await mainWindow.loadURL(loadElectronErrorHtml(devUrl));
        mainWindow.webContents.openDevTools({ mode: "detach" });
        return;
      }
      /**
       * 不可 await loadURL：其 Promise 會等到「整頁載入完成」才 resolve。
       * Next dev（Turbopack）首次編譯 / 可能需很久，期間會一直卡在上方「連線中」畫面。
       * 改為開始導向後即結束等待，讓畫面尽快顯示 Next 自己的載入／編譯畫面。
       */
      mainWindow.webContents.openDevTools({ mode: "detach" });
      mainWindow.loadURL(devUrl).catch(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          void mainWindow.loadURL(loadElectronErrorHtml(devUrl));
        }
      });
    })();
  } else {
    const indexPath = getStaticIndexHtml();
    if (!fs.existsSync(indexPath)) {
      void mainWindow.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(
          `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"/><title>缺少建置</title><style>body{font-family:system-ui;background:#0a0a0a;color:#fafafa;padding:24px}</style></head><body><p>找不到 <code>out/index.html</code>。請先執行 <code>npm run build:electron-static</code> 再打包，或使用開發模式 <code>npm run electron:dev</code>。</p></body></html>`,
        )}`,
      );
      return;
    }
    mainWindow.loadFile(indexPath);
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

/** 供前端產生波形：部分環境下 fetch(media://…) 不可靠，改由主進程讀檔 */
ipcMain.handle("media:readFile", (_event, filePath) => {
  if (typeof filePath !== "string" || !filePath) return null;
  try {
    const normalized = path.normalize(filePath);
    if (!fs.existsSync(normalized)) return null;
    const st = fs.statSync(normalized);
    if (!st.isFile()) return null;
    return fs.readFileSync(normalized);
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

function isYoutubeHttpUrl(s) {
  const t = String(s || "").trim().toLowerCase();
  if (!t.startsWith("http://") && !t.startsWith("https://")) return false;
  return (
    t.includes("youtube.com") ||
    t.includes("youtu.be") ||
    t.includes("youtube-nocookie.com")
  );
}

/**
 * @returns {Promise<{ ok: boolean, available?: boolean, label?: string, lang?: string, source?: string, error?: string }>}
 */
function runYoutubeSubsProbe(url) {
  const { scriptPath, cwd: pyCwd } = getPythonServicePaths();
  const pyCfg = getPythonSpawnConfig();
  const { cmd: pyCmd, argsPrefix, pythonHome } = pyCfg;
  const args = [
    ...argsPrefix,
    scriptPath,
    "--probe-youtube-subs",
    "--input",
    url,
  ];
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

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(pyCmd, args, {
        cwd: pyCwd,
        env: pyEnv,
      });
    } catch (e) {
      resolve({
        ok: false,
        available: false,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      resolve({
        ok: false,
        available: false,
        error: "檢查字幕逾時，請稍後再試。",
      });
    }, 120000);
    child.stdout?.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("close", () => {
      clearTimeout(timer);
      const lines = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const last = lines[lines.length - 1] || "";
      try {
        resolve(JSON.parse(last));
      } catch {
        resolve({
          ok: false,
          available: false,
          error:
            stderr.trim().slice(0, 500) ||
            stdout.trim().slice(0, 500) ||
            "無法解析字幕檢查結果。",
        });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, available: false, error: err.message });
    });
  });
}

ipcMain.handle("youtube:probeSubtitles", async (_event, url) => {
  if (typeof url !== "string" || !url.trim()) {
    return { ok: false, available: false, error: "無效的網址。" };
  }
  if (!isYoutubeHttpUrl(url)) {
    return { ok: true, available: false };
  }
  if (process.platform === "win32") {
    const listed = listWindowsPythonCandidates();
    const pyCfg = getPythonSpawnConfig();
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
        available: false,
        error:
          "Python 環境不完整，無法檢查字幕。請依轉錄功能相同方式修復 Python 後再試。",
      };
    }
  }
  return runYoutubeSubsProbe(url.trim());
});

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

ipcMain.handle("transcribe:start", async (_event, payload) => {
  let filePath;
  let youtubeSubsMode = null;
  if (typeof payload === "string") {
    filePath = payload;
  } else if (payload && typeof payload === "object") {
    filePath = payload.input;
    if (
      payload.youtubeSubsMode === "whisper" ||
      payload.youtubeSubsMode === "import"
    ) {
      youtubeSubsMode = payload.youtubeSubsMode;
    }
  } else {
    return { ok: false, error: "缺少輸入。" };
  }
  if (!filePath || typeof filePath !== "string") {
    return { ok: false, error: "缺少輸入。" };
  }

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
  if (youtubeSubsMode) {
    args.push("--youtube-subs-mode", youtubeSubsMode);
  }

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
    pythonProcess = null;
    /**
     * 以 microtask 延後廣播 done，讓同一次事件迴圈中 stdout 已排程的處理先跑完，
     * 且早於下一個使用者互動／新任務，避免 close 與最後幾行 JSON 競態導致逐字稿為空。
     */
    queueMicrotask(() => {
      broadcastTranscribe({ type: "done", code: exitCode });
    });
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
  /** 剪貼簿 IPC 已在載入 ipc-extra 時註冊；其餘 IPC（含 db、speaker）於此註冊後再開視窗 */
  registerExtraIpc(() => mainWindow);
  createWindow();
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
  killSpeakerAssignProcess();
  if (process.platform !== "darwin") app.quit();
});
