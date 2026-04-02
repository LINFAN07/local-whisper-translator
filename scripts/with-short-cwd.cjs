/**
 * Windows：專案在含中文／OneDrive 路徑時，Next dev 對 .next 的 readlink 可能 EINVAL，
 * Electron reload 會出現 Internal Server Error。
 * 優先試 8.3 短路徑；若無則在 %LOCALAPPDATA% 底下建立 directory junction，使 cwd 為純 ASCII。
 */
const { spawn, execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function hasNonAscii(s) {
  return /[^\x00-\x7F]/.test(s);
}

function winShortPath(abs) {
  const resolved = path.resolve(abs);
  if (process.platform !== "win32") {
    return resolved;
  }
  try {
    const winPath = resolved.replace(/\//g, "\\");
    const out = execFileSync(
      process.env.ComSpec || "cmd.exe",
      ["/c", `@for %I in ("${winPath.replace(/"/g, '\\"')}") do @echo %~sI`],
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    )
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (out && out !== winPath && fs.existsSync(path.join(out, "package.json"))) {
      return out;
    }
  } catch {
    /* ignore */
  }

  try {
    const quoted = String(resolved).replace(/'/g, "''");
    const psCmd = `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${quoted}').ShortPath`;
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psCmd],
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    ).trim();
    if (out && fs.existsSync(path.join(out, "package.json"))) {
      return out;
    }
  } catch {
    /* ignore */
  }
  return resolved;
}

function junctionRunCwd(longAbs) {
  const id = crypto.createHash("md5").update(longAbs).digest("hex").slice(0, 16);
  const base = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "voice-translator-run")
    : path.join(os.homedir(), "AppData", "Local", "voice-translator-run");
  const link = path.join(base, id);
  const marker = path.join(link, "package.json");

  if (fs.existsSync(marker)) {
    return link;
  }
  fs.mkdirSync(base, { recursive: true });
  if (fs.existsSync(link)) {
    /** junction 只能用 rmdir 拿掉；勿對連結點 fs.rmSync recursive，以免波及目標目錄 */
    execFileSync("cmd.exe", ["/c", "rmdir", link], { windowsHide: true });
  }
  execFileSync("cmd.exe", ["/c", "mklink", "/J", link, longAbs], {
    windowsHide: true,
    encoding: "utf8",
  });
  if (!fs.existsSync(marker)) {
    throw new Error(`junction 建立後仍無法存取 package.json：${link}`);
  }
  return link;
}

function resolveRunCwd(projectRoot) {
  const resolved = path.resolve(projectRoot);
  if (process.platform !== "win32" || !hasNonAscii(resolved)) {
    return resolved;
  }
  const short = winShortPath(resolved);
  if (short !== resolved && fs.existsSync(path.join(short, "package.json"))) {
    return short;
  }
  try {
    return junctionRunCwd(resolved);
  } catch (e) {
    console.warn(
      `[voice-translator] 無法建立 ASCII 工作目錄 junction：${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return resolved;
  }
}

const projectRoot = path.resolve(__dirname, "..");
const cwd = resolveRunCwd(projectRoot);
const npmScript = process.argv[2];

if (!npmScript) {
  console.error("Usage: node scripts/with-short-cwd.cjs <npm-script-name> [-- ...args]");
  process.exit(1);
}

if (
  process.platform === "win32" &&
  cwd === path.resolve(projectRoot) &&
  hasNonAscii(projectRoot)
) {
  console.warn(
    "[voice-translator] 專案路徑含非 ASCII 且無法自動切換工作目錄；若 Next／Electron reload 出現 Internal Server Error，請將專案移到僅含英數的路徑。",
  );
}

const rawExtra = process.argv.slice(3);
/** 去掉 npm 傳給子指令時多餘的 `--` */
const extra = rawExtra[0] === "--" ? rawExtra.slice(1) : rawExtra;

/** Windows：Node 24 對 npm.cmd 直接 spawn 可能 EINVAL，改由 cmd 執行 */
function runNpm() {
  if (process.platform !== "win32") {
    const args = ["run", npmScript];
    if (extra.length) {
      args.push("--", ...extra);
    }
    return spawn("npm", args, {
      cwd,
      stdio: "inherit",
      env: process.env,
      shell: false,
    });
  }
  /** cmd：僅含空白時加引號（`dev:next` 等勿加，否則 npm 會收到多餘引號） */
  const cmdQ = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const argOrQ = (a) => {
    const t = String(a);
    return /\s/.test(t) ? cmdQ(t) : t;
  };
  const cdPart = /\s/.test(cwd) ? cmdQ(cwd) : cwd;
  let cmdLine = `cd /d ${cdPart} && npm run ${argOrQ(npmScript)}`;
  if (extra.length) {
    cmdLine += ` -- ${extra.map(argOrQ).join(" ")}`;
  }
  return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", cmdLine], {
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
}

const child = runNpm();

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code === null ? 1 : code);
});
