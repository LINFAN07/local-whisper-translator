/**
 * Windows：檢查登錄中的 Python 是否含完整標準函式庫，並以 pip 安裝 faster-whisper。
 * 非 Windows：提示使用 python3 -m pip。
 */
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  listWindowsPythonCandidates,
} = require("../electron/python-locate.cjs");

const req = path.join(__dirname, "..", "python_service", "requirements.txt");
const cudaReq = path.join(
  __dirname,
  "..",
  "python_service",
  "requirements-cuda-windows.txt",
);

if (process.platform !== "win32") {
  console.log("請執行：python3 -m pip install -r python_service/requirements.txt");
  process.exit(0);
}

const listed = listWindowsPythonCandidates();
const good = listed.find((c) => c.ok);

if (!good) {
  console.error("");
  console.error("[語音辨識與翻譯] 找不到可用的 Python 安裝。");
  if (listed.length === 0) {
    console.error(
      "  未在 %LOCALAPPDATA%\\Programs\\Python 或登錄檔中找到 python.exe。",
    );
  } else {
    console.error("  下列安裝缺少標準函式庫（例如 Lib\\encodings），無法使用：");
    for (const c of listed) {
      console.error(`    - ${c.exe}`);
    }
  }
  console.error("");
  console.error("請修復方式擇一：");
  console.error("  1. 開啟「設定 → 應用程式」移除損壞的 Python，再到 https://www.python.org/downloads/ 重新安裝，勾選「Add python.exe to PATH」。");
  console.error("  2. 安裝完成後再執行：npm run setup:python");
  console.error("");
  process.exit(1);
}

console.log(`使用：${good.exe}`);
const env = {
  ...process.env,
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
  PYTHONHOME: good.prefix,
};
delete env.PYTHONPATH;

const pip = spawnSync(
  good.exe,
  ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
  { stdio: "inherit", env, cwd: path.join(__dirname, "..") },
);
if ((pip.status ?? 1) !== 0) process.exit(pip.status ?? 1);

const inst = spawnSync(
  good.exe,
  ["-m", "pip", "install", "-r", req],
  { stdio: "inherit", env, cwd: path.join(__dirname, "..") },
);
if ((inst.status ?? 1) !== 0) process.exit(inst.status ?? 1);

const cudaInst = spawnSync(
  good.exe,
  ["-m", "pip", "install", "-r", cudaReq],
  { stdio: "inherit", env, cwd: path.join(__dirname, "..") },
);
if ((cudaInst.status ?? 1) !== 0) {
  console.warn("");
  console.warn(
    "[語音辨識與翻譯] Windows GPU 套件（cuBLAS／cuDNN）安裝失敗，仍可使用 CPU 轉錄。",
  );
  console.warn(
    "  若需 GPU，請確認 Python 版本有對應 wheel（建議 3.12），並手動執行：",
  );
  console.warn(
    `  "${good.exe}" -m pip install -r python_service/requirements-cuda-windows.txt`,
  );
  console.warn("");
}
process.exit(0);
