const fs = require("node:fs");
const path = require("node:path");
const { execSync, spawnSync } = require("node:child_process");

function commandOnPathWin(name) {
  try {
    execSync(`where.exe ${name}`, {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} fullRegKey e.g. HKCU\SOFTWARE\Python\PythonCore\3.12\InstallPath
 */
function regGetExecutablePath(fullRegKey) {
  try {
    const r = spawnSync(
      "reg",
      ["query", fullRegKey, "/v", "ExecutablePath"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    if (r.status !== 0 || !r.stdout) return null;
    const out = r.stdout;
    for (const line of out.split("\n")) {
      const t = line.trim();
      if (t.includes("ExecutablePath") && /REG_SZ/i.test(t)) {
        const parts = t.split(/REG_SZ/i);
        if (parts.length >= 2) return parts[parts.length - 1].trim();
      }
    }
  } catch {
    /* not installed */
  }
  return null;
}

/** 標準函式庫是否完整（避免僅剩 site-packages 的毀損安裝） */
function isHealthyPythonInstall(exePath) {
  if (!exePath || !fs.existsSync(exePath)) return false;
  const prefix = path.dirname(exePath);
  return fs.existsSync(path.join(prefix, "Lib", "encodings", "__init__.py"));
}

/**
 * 掃描 %LOCALAPPDATA%\\Python\\pythoncore-*\\python.exe（Microsoft Store / 新版安裝程式常見位置）
 */
function listLocalPythonCoreInstalls() {
  const base = process.env.LOCALAPPDATA;
  if (!base) return [];
  const root = path.join(base, "Python");
  if (!fs.existsSync(root)) return [];
  /** @type {import("node:fs").Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirNames = entries
    .filter((e) => e.isDirectory() && /^pythoncore-/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  /** @type {{ exe: string; prefix: string; ok: boolean }[]} */
  const out = [];
  for (const name of dirNames) {
    const exe = path.join(root, name, "python.exe");
    if (!fs.existsSync(exe)) continue;
    const prefix = path.dirname(exe);
    out.push({ exe, prefix, ok: isHealthyPythonInstall(exe) });
  }
  return out;
}

/**
 * 掃描 %LOCALAPPDATA%\\Programs\\Python\\*\\python.exe（可略過登錄，抓到新安裝或僅檔案完好的副本）
 */
function listLocalAppDataPythonInstalls() {
  const base = process.env.LOCALAPPDATA;
  if (!base) return [];
  const root = path.join(base, "Programs", "Python");
  if (!fs.existsSync(root)) return [];
  /** @type {import("node:fs").Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirNames = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  /** @type {{ exe: string; prefix: string; ok: boolean }[]} */
  const out = [];
  for (const name of dirNames) {
    const exe = path.join(root, name, "python.exe");
    if (!fs.existsSync(exe)) continue;
    const prefix = path.dirname(exe);
    out.push({ exe, prefix, ok: isHealthyPythonInstall(exe) });
  }
  return out;
}

/** 目錄掃描在前（較新版本優先），再併入登錄檔項目並去重 */
function listWindowsPythonCandidates() {
  const seen = new Set();
  /** @type {{ exe: string; prefix: string; ok: boolean }[]} */
  const merged = [];
  for (const c of [
    ...listLocalPythonCoreInstalls(),
    ...listLocalAppDataPythonInstalls(),
    ...listWindowsRegistryPythons(),
  ]) {
    const k = c.exe.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(c);
  }
  return merged;
}

function listWindowsRegistryPythons() {
  const versions = ["3.13", "3.12", "3.11", "3.10", "3.9"];
  const roots = [
    "HKCU\\SOFTWARE\\Python\\PythonCore",
    "HKLM\\SOFTWARE\\Python\\PythonCore",
    "HKLM\\SOFTWARE\\WOW6432Node\\Python\\PythonCore",
  ];
  const seen = new Set();
  /** @type {{ exe: string; prefix: string; ok: boolean }[]} */
  const found = [];
  for (const root of roots) {
    for (const ver of versions) {
      const key = `${root}\\${ver}\\InstallPath`;
      const exe = regGetExecutablePath(key);
      if (!exe || seen.has(exe.toLowerCase())) continue;
      seen.add(exe.toLowerCase());
      found.push({
        exe,
        prefix: path.dirname(exe),
        ok: isHealthyPythonInstall(exe),
      });
    }
  }
  return found;
}

/**
 * @returns {{ cmd: string; argsPrefix: string[]; pythonHome?: string }}
 */
function getPythonSpawnConfig() {
  const custom =
    process.env.VOICE_TRANSLATOR_PYTHON ||
    process.env.PYTHON_EXECUTABLE ||
    process.env.PYTHON;
  if (custom && String(custom).trim()) {
    const cmd = String(custom).trim().replace(/^"+|"+$/g, "");
    const ok = isHealthyPythonInstall(cmd);
    return {
      cmd,
      argsPrefix: [],
      pythonHome: ok ? path.dirname(cmd) : undefined,
    };
  }

  if (process.platform === "win32") {
    const candidates = listWindowsPythonCandidates();
    const good = candidates.find((c) => c.ok);
    if (good) {
      return {
        cmd: good.exe,
        argsPrefix: [],
        pythonHome: good.prefix,
      };
    }

    if (commandOnPathWin("py")) {
      return { cmd: "py", argsPrefix: ["-3"], pythonHome: undefined };
    }
    if (commandOnPathWin("python")) {
      return { cmd: "python", argsPrefix: [], pythonHome: undefined };
    }
    return { cmd: "py", argsPrefix: ["-3"], pythonHome: undefined };
  }

  return { cmd: "python3", argsPrefix: [], pythonHome: undefined };
}

module.exports = {
  getPythonSpawnConfig,
  listWindowsPythonCandidates,
  listLocalPythonCoreInstalls,
  listWindowsRegistryPythons,
  isHealthyPythonInstall,
  commandOnPathWin,
};
