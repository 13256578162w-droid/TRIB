// 分流 TRIB —— Electron 主进程（CommonJS，最稳的加载方式）
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/* ---------- 最早期的日志：在任何东西之前就把痕迹写下来 ---------- */
const APP_DIR = path.dirname(process.execPath);
const TEMP_DIR = path.join(os.tmpdir(), "trib");
const LOG_CANDIDATES = [path.join(APP_DIR, "boot.log"), path.join(TEMP_DIR, "boot.log")];

function writeLog(line) {
  const text = new Date().toISOString() + "  " + line + "\r\n";
  let ok = false;
  for (const f of LOG_CANDIDATES) {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, text);
      ok = true;
    } catch (e) { /* 试下一个位置 */ }
  }
  if (!ok) { try { process.stdout.write(text); } catch (e) {} }
}
function log() {
  writeLog(Array.prototype.slice.call(arguments).map(function (a) {
    return a && a.stack ? a.stack : String(a);
  }).join(" "));
}

log("=== main.cjs 开始执行 ===");
log("execPath:", process.execPath);
log("appDir:", APP_DIR);

let electron;
try {
  electron = require("electron");
  log("require('electron') ok");
} catch (e) {
  log("!! require('electron') 失败:", e);
  process.exit(1);
}

const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Notification } = electron;

process.on("uncaughtException", function (e) { log("!! uncaughtException:", e); });
process.on("unhandledRejection", function (e) { log("!! unhandledRejection:", e); });
process.on("exit", function (code) { log("process exit, code=" + code); });

try {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  log("switches applied");
} catch (e) { log("!! 设置启动参数失败:", e); }

const ROOT = __dirname.replace(/electron$/, "");
const DEFAULT_ANNOUNCE = "https://cdn.jsdelivr.net/gh/13256578162w-droid/TRIB@main/announcements.json";
log("ROOT:", ROOT, "| packaged:", (function () { try { return app.isPackaged; } catch (e) { return "?"; } })());

/** 找一个最像"玩家在用的"游戏目录：版本最多的那个 */
function detectGameDir() {
  const cands = [
    path.join(APP_DIR, ".minecraft"),
    path.join(path.dirname(APP_DIR), ".minecraft"),
    path.join(app.getPath("appData"), ".minecraft"),
  ];
  // 扫各盘根目录下一层，找 D:\Release 2.4.4\.minecraft 这种
  for (const L of ["C","D","E","F","G","H"]) {
    const root = L + ":\\";
    let subs = [];
    try { subs = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
    let n = 0;
    for (const d of subs) {
      if (!d.isDirectory()) continue;
      if (++n > 60) break;
      const p2 = path.join(root, d.name, ".minecraft");
      try { if (fs.existsSync(p2)) cands.push(p2); } catch (e) { /* ignore */ }
    }
  }
  let best = cands[0], bestCount = -1;
  for (const c of cands) {
    let n = 0;
    try { n = fs.readdirSync(path.join(c, "versions")).length; } catch (e) { n = 0; }
    log("候选目录:", c, "版本数:", n);
    if (n > bestCount) { bestCount = n; best = c; }
  }
  return best;
}

/** 扫描本机启动器：靠 gameDir 里的标记文件认人 */
function detectLaunchers(defaultDir) {
  const seen = new Set();
  const out = [];
  const cands = [];

  const push = (p) => { if (p && !cands.includes(p)) cands.push(p); };
  push(path.join(APP_DIR, ".minecraft"));
  push(path.join(path.dirname(APP_DIR), ".minecraft"));
  push(path.join(app.getPath("appData"), ".minecraft"));
  if (defaultDir) push(defaultDir);

  for (const L of ["C", "D", "E", "F", "G", "H"]) {
    const root = L + ":\\";
    let subs = [];
    try { subs = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
    let n = 0;
    for (const d of subs) {
      if (!d.isDirectory()) continue;
      if (++n > 60) break;
      push(path.join(root, d.name, ".minecraft"));
      push(path.join(root, d.name, "minecraft"));
    }
  }

  for (const dir of cands) {
    let key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let versions = 0;
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      versions = fs.readdirSync(path.join(dir, "versions")).length;
    } catch (e) { continue; }

    let name = "Minecraft 目录";
    try {
      if (fs.existsSync(path.join(dir, "PCL.ini"))) name = "PCL";
      else if (fs.existsSync(path.join(dir, ".hmcl.json")) || fs.existsSync(path.join(dir, "hmcl.json"))) name = "HMCL";
      else if (fs.existsSync(path.join(dir, "launcher_profiles.json"))) name = "官方启动器";
    } catch (e) { /* ignore */ }

    out.push({ name: name, dir: dir, count: versions });
  }
  out.sort(function (a, b) { return b.count - a.count; });
  return out.slice(0, 6);
}

function baseDir() {
  try { return app.isPackaged ? APP_DIR : ROOT; } catch (e) { return ROOT; }
}

let win = null;

function createWindow() {
  log("creating window");
  win = new BrowserWindow({
    width: 1280, height: 800,
    minWidth: 1024, minHeight: 680,
    backgroundColor: "#f3f7f6",
    title: "分流 TRIB",
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  log("window created");
  try { win.setMenuBarVisibility(false); } catch (e) { log("menu bar:", e.message); }

  win.on("close", function (e) {
    if (downloadingCount > 0) {
      e.preventDefault();
      dialog.showMessageBox(win, {
        type: "question",
        title: "正在下载",
        message: "还有任务在下载中",
        detail: "关闭窗口会中断下载。选择「后台继续」可以最小化，下载完成后再提示你。",
        buttons: ["后台继续", "直接关闭", "取消"],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      }).then(function (r) {
        if (r.response === 0) {
          win.hide();
          var timer = setInterval(function () {
            if (downloadingCount === 0) {
              clearInterval(timer);
              try {
                win.show();
                win.flashFrame(true);
                if (Notification.isSupported()) new Notification({ title: "分流", body: "下载完成了" }).show();
              } catch (err) { /* ignore */ }
            }
          }, 1000);
        } else if (r.response === 1) {
          downloadingCount = 0;
          win.destroy();
          app.quit();
        }
      });
    }
  });

  win.webContents.on("did-finish-load", function () { log("did-finish-load"); });
  win.webContents.on("did-fail-load", function (e, code, desc, url) { log("!! did-fail-load", code, desc, url); });
  win.webContents.on("render-process-gone", function (e, d) { log("!! render-process-gone", JSON.stringify(d)); });
  win.webContents.on("preload-error", function (e, p, err) { log("!! preload-error", p, err && err.message); });
  win.webContents.on("console-message", function (e, level, message) { log("[renderer]", message); });

  const file = path.join(ROOT, "ui", "index.html");
  log("loading", file, "| exists:", fs.existsSync(file));
  win.loadFile(file).catch(function (e) {
    log("!! loadFile 失败:", e);
    const msg = "<body style='font-family:Microsoft YaHei;padding:40px;background:#f3f7f6'>" +
      "<h2 style='color:#b4483f'>界面加载失败</h2>" +
      "<p style='color:#586d66'>" + String(e && e.message || e) + "</p>" +
      "<p style='color:#8fa39d;font-size:13px'>日志：" + LOG_CANDIDATES[0] + "</p></body>";
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(msg));
  });

  setTimeout(function () {
    try {
      if (win && !win.isDestroyed() && !win.isVisible()) { log("强制显示窗口"); win.show(); }
    } catch (e) { log("force show 失败:", e.message); }
  }, 8000);
}

app.whenReady().then(function () {
  log("app ready");
  createWindow();
}).catch(function (e) { log("!! whenReady 失败:", e); });

app.on("window-all-closed", function () { if (process.platform !== "darwin") app.quit(); });

/* ---------------- IPC ---------------- */
let apiPromise = null;
function getApi() {
  if (!apiPromise) apiPromise = import("file:///" + path.join(ROOT, "core", "api.mjs").replace(/\\/g, "/"));
  return apiPromise;
}

let current = null;   // { id, controller }

function send(channel, payload) {
  try { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); } catch (e) { /* ignore */ }
}

// 任务栏进度：0~1，-1 清除
function setTaskbarProgress(frac) {
  try { if (win && !win.isDestroyed()) win.setProgressBar(frac); } catch (e) { /* ignore */ }
}

let downloadingCount = 0;   // 有任务在跑时，关窗口要确认

ipcMain.handle("app:info", function () {
  return { version: app.getVersion(), packaged: app.isPackaged, configDir: baseDir(), platform: process.platform, logFile: LOG_CANDIDATES[0] };
});

ipcMain.handle("config:get", async function () {
  const api = await getApi();
  const cfg = await api.loadConfig(baseDir());
  // 用户可能误选到 …\.minecraft\versions，这里纠正回上一层
  if (cfg.gameDir && /[\\/]versions[\\/]?$/i.test(cfg.gameDir)) {
    cfg.gameDir = cfg.gameDir.replace(/[\\/]versions[\\/]?$/i, "");
    log("游戏目录修正为:", cfg.gameDir);
  }
  if (!cfg.announceUrl) cfg.announceUrl = DEFAULT_ANNOUNCE;
  if (!cfg.gameDir) {
    cfg.gameDir = detectGameDir();
    log("自动选择游戏目录:", cfg.gameDir);
  }
  return cfg;
});

ipcMain.handle("config:set", async function (_e, cfg) {
  const api = await getApi();
  await api.saveConfig(baseDir(), cfg);
  return true;
});

ipcMain.handle("versions:list", async function (_e, opts) {
  const api = await getApi();
  const cfg = await api.loadConfig(baseDir());
  return api.listVersions(Object.assign({ mirrors: cfg.mirrors }, opts || {}));
});

let launcherCache = null;
ipcMain.handle("launchers", async function () {
  if (launcherCache) return launcherCache;
  const api = await getApi();
  const cfg = await api.loadConfig(baseDir());
  launcherCache = detectLaunchers(cfg.gameDir);
  log("检测到启动器:", JSON.stringify(launcherCache));
  return launcherCache;
});

ipcMain.handle("precheck", async function (_e, arg) {
  const api = await getApi();
  const cfg = await api.loadConfig(baseDir());
  return api.precheck({
    id: arg.id, loader: arg.loader, loaderVersion: arg.loaderVersion,
    dir: arg.dir || cfg.gameDir, mirrors: cfg.mirrors,
  });
});

ipcMain.handle("version:detail", async function (_e, arg) {
  const api = await getApi();
  const cfg = await api.loadConfig(baseDir());
  try { return await api.versionDetail(arg.id, { mirrors: cfg.mirrors }); } catch (e) { return null; }
});

ipcMain.handle("install:cancel", function () {
  if (current) {
    log("取消任务:", current.id);
    try { current.controller.abort(); } catch (e) { /* ignore */ }
    return true;
  }
  return false;
});

ipcMain.handle("versions:install", async function (_e, arg) {
  const api = await getApi();
  const cfg = await api.loadConfig(baseDir());
  const targetDir = arg.dir || cfg.gameDir;
  const controller = new AbortController();
  current = { id: arg.id, controller };
  send("install:start", { id: arg.id });

  const before = new Set();
  try { for (const n of fs.readdirSync(path.join(targetDir, "versions"))) before.add(n); } catch (e) { /* ignore */ }
  const diffNew = function () {
    try {
      return fs.readdirSync(path.join(targetDir, "versions")).filter(function (n) { return !before.has(n); });
    } catch (e) { return []; }
  };

  downloadingCount++;
  setTaskbarProgress(0);
  try {
    if (arg.loader && arg.loader !== "vanilla" && arg.loaderVersion) {
      log("安装 " + arg.id + " + " + arg.loader + " " + arg.loaderVersion + " -> " + targetDir);
      await api.installWithLoader({
        mc: arg.id, loader: arg.loader + ":" + arg.loaderVersion, dir: targetDir,
        mirrors: cfg.mirrors, threads: cfg.threads, signal: controller.signal,
        onEvent: function (p) { send("install:progress", Object.assign({ id: arg.id }, p)); syncProgress(p); },
        onLog: function (m) { send("install:log", { id: arg.id, message: m }); },
      });
    } else {
      log("安装原版 " + arg.id + " -> " + targetDir);
      await api.install({
        id: arg.id, dir: targetDir, mirrors: cfg.mirrors, threads: cfg.threads, signal: controller.signal,
        onEvent: function (p) { send("install:progress", Object.assign({ id: arg.id }, p)); },
        onLog: function (m) { send("install:log", { id: arg.id, message: m }); },
      });
    }

    // 改名
    let produced = diffNew()[0] || arg.id;
    let finalName = produced;
    if (arg.name && arg.name !== produced) {
      try {
        finalName = await api.renameVersion(targetDir, produced, arg.name);
        log("版本改名:", produced, "->", finalName);
      } catch (e) {
        log("!! 改名失败:", e.message);
      }
    }

    send("install:done", { id: arg.id, name: finalName, dir: targetDir });
    return { id: arg.id, name: finalName, dir: targetDir };
  } catch (e) {
    log("!! 安装失败:", e.message);
    send("install:error", { id: arg.id, message: e.message });
    throw e;
  } finally {
    current = null;
    downloadingCount = Math.max(0, downloadingCount - 1);
    setTaskbarProgress(-1);
    try { if (win && !win.isDestroyed()) win.flashFrame(false); } catch (e) { /* ignore */ }
  }
});

function syncProgress(p) {
  if (!p || !p.total) { setTaskbarProgress(0); return; }
  const frac = Math.max(0, Math.min(1, p.done / p.total));
  setTaskbarProgress(frac);
}

ipcMain.handle("loader:list", async function (_e, arg) {
  const api = await getApi();
  const cfg = await (await getApi()).loadConfig(baseDir());
  const mod = await import("file:///" + path.join(ROOT, "core", "loader.mjs").replace(/\\/g, "/"));
  return mod.listLoaderVersions({ loader: arg.loader, mc: arg.mc, mirrors: cfg.mirrors });
});

ipcMain.handle("loader:install", async function (_e, arg) {
  const api = await getApi();
  const cfg = await api.loadConfig(baseDir());
  const controller = new AbortController();
  current = { id: arg.mc, controller };
  send("install:start", { id: arg.mc });
  try {
    const r = await api.installWithLoader({
      mc: arg.mc, loader: arg.loader, dir: cfg.gameDir, mirrors: cfg.mirrors, threads: cfg.threads, signal: controller.signal,
      onEvent: function (p) { send("install:progress", Object.assign({ id: arg.mc }, p)); },
      onLog: function (m) { send("install:log", { id: arg.mc, message: m }); },
    });
    send("install:done", { id: arg.mc, ok: true });
    return r;
  } catch (e) {
    log("!! 加载器安装失败:", e.message);
    send("install:error", { id: arg.mc, message: e.message });
    throw e;
  } finally {
    current = null;
  }
});

ipcMain.handle("installed:scan", async function () {
  const api = await getApi();
  const cfg = await api.loadConfig(baseDir());
  return api.scanInstalled(cfg.gameDir);
});

ipcMain.handle("installed:check", async function (_e, arg) {
  const api = await getApi();
  const cfg = await api.loadConfig(baseDir());
  const r = await api.checkVersion(cfg.gameDir, arg.id, { deep: false });
  return { ok: r.ok, missing: r.missing.length, broken: r.broken.length, totalFiles: r.totalFiles, totalBytes: r.totalBytes };
});

ipcMain.handle("installed:repair", async function (_e, arg) {
  const api = await getApi();
  const cfg = await api.loadConfig(baseDir());
  return api.repairVersion(cfg.gameDir, arg.id, {
    mirrors: cfg.mirrors, threads: cfg.threads,
    onEvent: function (p) { send("repair:progress", Object.assign({ id: arg.id }, p)); },
  });
});

ipcMain.handle("installed:delete", async function (_e, arg) {
  const api = await getApi();
  const cfg = await api.loadConfig(baseDir());
  await api.deleteVersion(cfg.gameDir, arg.id);
  return true;
});

ipcMain.handle("installed:open", async function (_e, arg) {
  const api = await getApi();
  const cfg = await api.loadConfig(baseDir());
  const target = arg.id ? path.join(cfg.gameDir, "versions", arg.id) : cfg.gameDir;
  await shell.openPath(target);
  return true;
});

ipcMain.handle("clipboard:write", function (_e, text) {
  clipboard.writeText(String(text || ""));
  return true;
});

ipcMain.handle("announce:get", async function () {
  const api = await getApi();
  const cfg = await api.loadConfig(baseDir());
  const url = (cfg.announceUrl || "").trim();
  if (!url) return { configured: false, items: [] };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 8000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "TRIB/1.0" } });
    clearTimeout(timer);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const items = Array.isArray(data) ? data : (data.items || []);
    return { configured: true, items: items, updatedAt: new Date().toISOString() };
  } catch (e) {
    log("!! 公告拉取失败:", e.message);
    return { configured: true, items: [], error: e.message };
  }
});

ipcMain.handle("dir:pick", async function () {
  const api = await getApi();
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("log:open", function () { shell.openPath(LOG_CANDIDATES[0]); return true; });

if (process.env.TRIB_SHOT) {
  app.whenReady().then(function () {
    setTimeout(async function () {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.TRIB_SHOT, img.toPNG());
        log("shot saved");
      } catch (e) { log("!! shot failed:", e); }
      app.quit();
    }, Number(process.env.TRIB_SHOT_DELAY || 5000));
  });
}