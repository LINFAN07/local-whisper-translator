const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getFileUrl: (filePath) => ipcRenderer.invoke("media:fileUrl", filePath),
  readMediaFile: (filePath) => ipcRenderer.invoke("media:readFile", filePath),
  openFileDialog: () => ipcRenderer.invoke("dialog:openFile"),
  youtubeProbeSubtitles: (url) =>
    ipcRenderer.invoke("youtube:probeSubtitles", url),
  transcribeStart: (payload) => ipcRenderer.invoke("transcribe:start", payload),
  transcribeCancel: () => ipcRenderer.invoke("transcribe:cancel"),
  onTranscribeEvent: (cb) => {
    const handler = (_event, payload) => {
      cb(payload);
    };
    ipcRenderer.on("transcribe:event", handler);
    return () => {
      ipcRenderer.removeListener("transcribe:event", handler);
    };
  },

  settingsGet: () => ipcRenderer.invoke("settings:get"),
  settingsSet: (partial) => ipcRenderer.invoke("settings:set", partial),

  dbListTasks: () => ipcRenderer.invoke("db:tasks:list"),
  dbGetTask: (taskId) => ipcRenderer.invoke("db:tasks:get", taskId),
  dbSaveTask: (payload) => ipcRenderer.invoke("db:tasks:save", payload),
  dbDeleteTask: (taskId) => ipcRenderer.invoke("db:tasks:delete", taskId),

  fsSaveText: (opts) => ipcRenderer.invoke("fs:saveText", opts),
  /** 長文分塊送主程序；invoke 失敗時回傳物件，避免未處理的 Promise 拒絕打斷前端 */
  clipboardWriteText: async (text) => {
    const s = String(text ?? "");
    const chunkSize = 512 * 1024;
    try {
      if (s.length <= chunkSize) {
        return await ipcRenderer.invoke("clipboard:writeText", s);
      }
      const id =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ?
          crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        for (let i = 0; i < s.length; i += chunkSize) {
          const chunk = s.slice(i, i + chunkSize);
          const last = i + chunkSize >= s.length;
          const r = await ipcRenderer.invoke("clipboard:writeTextChunk", {
            id,
            chunk,
            last,
          });
          if (!r?.ok) {
            try {
              await ipcRenderer.invoke("clipboard:writeTextChunkCancel", id);
            } catch {
              /* ignore */
            }
            return r;
          }
        }
        return { ok: true };
      } catch (e) {
        try {
          await ipcRenderer.invoke("clipboard:writeTextChunkCancel", id);
        } catch {
          /* ignore */
        }
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  aiSummarize: (opts) => ipcRenderer.invoke("ai:summarize", opts),
  aiTranslateGoogle: (opts) => ipcRenderer.invoke("ai:translateGoogle", opts),
  aiTranslateOpenAI: (opts) => ipcRenderer.invoke("ai:translateOpenAI", opts),

  assignSpeakers: (opts) => ipcRenderer.invoke("speaker:assign", opts),
});
