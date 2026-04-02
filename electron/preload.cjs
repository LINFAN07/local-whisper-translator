const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getFileUrl: (filePath) => ipcRenderer.invoke("media:fileUrl", filePath),
  openFileDialog: () => ipcRenderer.invoke("dialog:openFile"),
  transcribeStart: (filePath) => ipcRenderer.invoke("transcribe:start", filePath),
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

  aiSummarize: (opts) => ipcRenderer.invoke("ai:summarize", opts),
  aiTranslateGoogle: (opts) => ipcRenderer.invoke("ai:translateGoogle", opts),
  aiTranslateOpenAI: (opts) => ipcRenderer.invoke("ai:translateOpenAI", opts),
});
