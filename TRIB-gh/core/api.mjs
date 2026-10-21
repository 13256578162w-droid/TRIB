// 对外门面：CLI 与 Electron 共用
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveMirrors, toMirrors, EmitterProgress, statOrNull, getJson, UA } from "./net.mjs";
import { fetchManifest, describeVersion } from "./mc.mjs";
import { installVersion } from "./install.mjs";
import { installLoader } from "./loader.mjs";
import { checkVersion, repairVersion, collectExpected } from "./fscheck.mjs";
import { loadVersionTree } from "./launch.mjs";

export { checkVersion, repairVersion };

const MANIFEST_PROBE = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
const JAVA_CACHE = new Map();

/* ---------------- 配置 ---------------- */

export function configPaths(baseDir) {
  return {
    config: path.join(baseDir, "config.json"),
    sources: path.join(baseDir, "sources.json"),
  };
}

const DEFAULT_CONFIG = {
  gameDir: "",
  mirrors: ["official", "bmclapi"],
  threads: 32,
  autoVerify: true,
  showMascot: true,
  memory: "4G",
  offlineName: "Steve",
  javaPath: "",
  announceUrl: "https://cdn.jsdelivr.net/gh/13256578162w-droid/TRIB@main/announcements.json",
};

export async function loadConfig(baseDir) {
  const p = configPaths(baseDir).config;
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(await fsp.readFile(p, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(baseDir, cfg) {
  const p = configPaths(baseDir).config;
  await fsp.writeFile(p, JSON.stringify({ ...DEFAULT_CONFIG, ...cfg }, null, 2), "utf8");
}

/* ---------------- 版本列表 ---------------- */

export async function listVersions({ mirrors = ["official", "bmclapi"], search = "", type = "all", limit = 0 } = {}) {
  const m = resolveMirrors(mirrors);
  const manifest = await fetchManifest(m);
  let list = manifest.versions;
  if (type && type !== "all") list = list.filter((v) => v.type === type);
  if (search) {
    const q = String(search).toLowerCase();
    list = list.filter((v) => v.id.toLowerCase().includes(q));
  }
  const out = list.map((v) => ({ id: v.id, type: v.type, date: (v.releaseTime || "").slice(0, 10) }));
  return { latest: manifest.latest, total: out.length, versions: limit > 0 ? out.slice(0, limit) : out };
}

/* ---------------- 安装 ---------------- */

export async function install({ id, dir, mirrors, threads = 16, verify = false, onEvent, onLog, signal }) {
  const m = resolveMirrors(mirrors);
  const log = onLog || (() => {});
  const progressFactory = onEvent
    ? (label, total) => new EmitterProgress(label, total, onEvent)
    : undefined;

  const vjson = await installVersion({
    versionId: id, dir, mirrors: m, threads, verify,
    log, progressFactory, signal,
  });
  return { id: vjson.id, type: vjson.type };
}

export async function installWithLoader({ mc, loader, dir, mirrors, threads = 16, onEvent, onLog, signal }) {
  const m = resolveMirrors(mirrors);
  const log = onLog || (() => {});
  const progressFactory = onEvent ? (label, total) => new EmitterProgress(label, total, onEvent) : undefined;

  await installVersion({ versionId: mc, dir, mirrors: m, threads, log, progressFactory, signal });
  const res = await installLoader({ loader, mcVersion: mc, dir, mirrors: m, log });
  return res;
}

/* ---------------- 安装预检 ---------------- */

export async function precheck({ id, loader, loaderVersion, dir, mirrors = ["official", "bmclapi"] }) {
  const m = resolveMirrors(mirrors);

  // 版本本身
  const detail = await versionDetail(id, { mirrors });

  // 已安装？
  const targetDir = path.join(dir, "versions", id);
  const installed = !!(await statOrNull(targetDir));
  let installedFiles = 0;
  if (installed) {
    try { installedFiles = (await fsp.readdir(targetDir)).length; } catch (e) { /* ignore */ }
  }

  // 磁盘剩余
  let free = null, drive = "";
  try {
    const st = await fsp.statfs(dir);
    free = st.bavail * st.bsize;
    drive = path.parse(path.resolve(dir)).root;
  } catch (e) { /* ignore */ }

  // Java（并行探测 + 进程内缓存，避免每次预检都跑一遍）
  const { collectJavaCandidates, javaVersion } = await import("./java.mjs");
  const cands = await collectJavaCandidates(dir);
  const metas = await Promise.all(cands.slice(0, 8).map(async (c) => {
    if (JAVA_CACHE.has(c)) return { path: c, major: JAVA_CACHE.get(c) };
    const v = await javaVersion(c);
    if (!v) return null;
    JAVA_CACHE.set(c, v.major);
    return { path: c, major: v.major };
  }));
  const javas = metas.filter(Boolean);

  // 源测速（并行，超时 4 秒）
  const probe = async (mirrorId) => {
    const t0 = Date.now();
    try {
      const t = toMirrors([mirrorId])[0];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(t.map(MANIFEST_PROBE), { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA } });
      clearTimeout(timer);
      return res.ok ? Date.now() - t0 : null;
    } catch (e) { return null; }
  };
  const [officialMs, mirrorMs] = await Promise.all([probe("official"), probe("bmclapi")]);

  const loaderBytes = loader && loader !== "vanilla" ? ({ NeoForge: 55e6, Forge: 65e6, Fabric: 12e6 }[loader] || 40e6) : 0;
  const downloadBytes = (detail.clientBytes || 0) + (detail.assetBytes || 0) + (detail.libBytes || 0) + loaderBytes;

  return {
    id,
    java: { required: detail.java || 8, available: javas },
    bytes: {
      client: detail.clientBytes || 0,
      assets: detail.assetBytes || 0,
      libs: detail.libBytes || 0,
      loader: loaderBytes,
      total: downloadBytes,
    },
    disk: { free, drive },
    installed, installedFiles,
    libraryCount: detail.libraryCount || 0,
    sources: { official: officialMs, bmclapi: mirrorMs },
    date: detail.date,
  };
}

/* ---------------- 版本改名 ---------------- */

export async function renameVersion(dir, oldId, newId) {
  if (!newId || newId === oldId) return oldId;
  if (/[\\/:*?"<>|]/.test(newId)) throw new Error("名称里不能有 \\ / : * ? \" < > |");
  const versionsDir = path.join(dir, "versions");
  const from = path.join(versionsDir, oldId);
  const to = path.join(versionsDir, newId);
  if (!(await statOrNull(from))) throw new Error("版本不存在: " + oldId);
  if (await statOrNull(to)) throw new Error("已经有同名版本了: " + newId);

  // 有别的版本继承它就不能改
  for (const name of await fsp.readdir(versionsDir)) {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(versionsDir, name, name + ".json"), "utf8"));
      if (j.inheritsFrom === oldId) throw new Error(name + " 继承自这个版本，不能改名");
    } catch (e) { if (e.message && e.message.includes("继承")) throw e; }
  }

  await fsp.rename(from, to);
  const oldJson = path.join(to, oldId + ".json");
  const data = JSON.parse(await fsp.readFile(oldJson, "utf8"));
  data.id = newId;
  await fsp.writeFile(path.join(to, newId + ".json"), JSON.stringify(data, null, 2), "utf8");
  await fsp.rm(oldJson, { force: true });
  const oldJar = path.join(to, oldId + ".jar");
  if (await statOrNull(oldJar)) await fsp.rename(oldJar, path.join(to, newId + ".jar"));
  return newId;
}

/* ---------------- 已安装扫描 ---------------- */

export async function scanInstalled(dir) {
  const vdir = path.join(dir, "versions");
  let names = [];
  try {
    names = (await fsp.readdir(vdir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const jsonFile = path.join(vdir, name, name + ".json");
    let merged = null;
    try { merged = (await loadVersionTree(dir, name)).merged; } catch { continue; }

    let bytes = 0;
    const client = merged.downloads && merged.downloads.client;
    if (client) bytes += client.size || 0;
    for (const lib of merged.libraries || []) {
      const a = lib.downloads && lib.downloads.artifact;
      if (a && a.size) bytes += a.size;
    }
    if (merged.assetIndex && merged.assetIndex.totalSize) bytes += merged.assetIndex.totalSize;

    let state = { ok: null, missing: 0 };
    try {
      const rep = await checkVersion(dir, name, { skipAssets: true });
      state = { ok: rep.ok, missing: rep.missing.length + rep.broken.length };
    } catch { /* 保留 null */ }

    out.push({
      id: name,
      type: merged.type || "release",
      loader: merged.inheritsFrom ? name.replace(/^.*?-(?=.*)/, "") : "",
      java: (merged.javaVersion && merged.javaVersion.majorVersion) || 8,
      bytes,
      inheritsFrom: merged.inheritsFrom || null,
      ok: state.ok,
      missing: state.missing,
    });
  }
  out.sort((a, b) => (a.id < b.id ? 1 : -1));
  return out;
}

export async function deleteVersion(dir, id) {
  const target = path.join(dir, "versions", id);
  const st = await statOrNull(target);
  if (!st) throw new Error("版本不存在: " + id);
  await fsp.rm(target, { recursive: true, force: true });
}

/** 任意版本（含未安装）的元信息：Java 版本 + 体积 */
export async function versionDetail(id, { mirrors = ["official", "bmclapi"] } = {}) {
  const m = resolveMirrors(mirrors);
  const manifest = await fetchManifest(m);
  const e = manifest.versions.find((v) => v.id === id);
  if (!e) return null;
  const { data } = await getJson(e.url, m, { label: "版本 " + id });
  const clientBytes = (data.downloads && data.downloads.client && data.downloads.client.size) || 0;
  const assetBytes = (data.assetIndex && data.assetIndex.totalSize) || 0;
  let libBytes = 0;
  for (const lib of data.libraries || []) {
    const a = lib.downloads && lib.downloads.artifact;
    if (a && a.size) libBytes += a.size;
  }
  return {
    id, type: data.type,
    java: (data.javaVersion && data.javaVersion.majorVersion) || 8,
    mb: Math.round((clientBytes + assetBytes + libBytes) / 1048576),
    clientBytes, assetBytes, libBytes,
    date: (data.releaseTime || "").slice(0, 10),
    libraryCount: (data.libraries || []).length,
    assetCount: 0,
  };
}

/** 版本详情（已安装的，给右侧信息面板用） */
export async function versionInfo(dir, id) {
  const { merged, jarId } = await loadVersionTree(dir, id);
  return {
    id,
    inheritsFrom: merged.inheritsFrom || null,
    mainClass: merged.mainClass || "",
    java: (merged.javaVersion && merged.javaVersion.majorVersion) || 8,
    assets: merged.assets || (merged.assetIndex && merged.assetIndex.id) || "",
    libraries: (merged.libraries || []).length,
  };
}