// 网络层：多镜像下载、SHA1 校验、并发、进度显示
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const UA = "MCDL/1.0 (local installer)";

/* ------------------------------------------------------------------ */
/* 镜像                                                                */
/* ------------------------------------------------------------------ */

function bmclMap(url) {
  let u;
  try { u = new URL(url); } catch { return url; }
  const p = u.pathname;
  const q = u.search || "";

  if (u.hostname === "piston-meta.mojang.com" || u.hostname === "launchermeta.mojang.com") {
    const m = p.match(/^\/v1\/packages\/[0-9a-f]+\/(.+)\.json$/i);
    if (m) return "https://bmclapi2.bangbang93.com/version/" + encodeURIComponent(m[1]) + "/json";
    if (/^\/v1\/packages\/[0-9a-f]+\/client\.jar$/i.test(p)) {
      const id = p.split("/").pop().replace(/\.jar$/i, "");
      return "https://bmclapi2.bangbang93.com/version/" + encodeURIComponent(id) + "/client";
    }
    return "https://bmclapi2.bangbang93.com" + p + q;
  }
  if (u.hostname === "resources.download.minecraft.net") return "https://bmclapi2.bangbang93.com/assets" + p;
  if (u.hostname === "libraries.minecraft.net") return "https://bmclapi2.bangbang93.com/libraries" + p;
  if (/maven|forge|neoforged|minecraftforge/i.test(u.hostname)) {
    const m = p.match(/^\/(?:releases|maven2|maven)\/(.*)$/);
    return "https://bmclapi2.bangbang93.com/maven/" + (m ? m[1] : p.replace(/^\//, ""));
  }
  if (u.hostname.endsWith("mojang.com") || u.hostname.endsWith("minecraft.net")) return "https://bmclapi2.bangbang93.com" + p + q;
  return url;
}

export const MIRRORS = {
  official: { id: "official", name: "官方源", map: (u) => u },
  bmclapi: { id: "bmclapi", name: "BMCLAPI", map: bmclMap },
};

/** 允许传 ["official","bmclapi"] 或镜像对象数组，统一成对象数组 */
export function toMirrors(input) {
  if (!input) return resolveMirrors(undefined);
  const list = (Array.isArray(input) ? input : [input]).map((x) => (typeof x === "string" ? MIRRORS[x] : x));
  for (const m of list) { if (!m || typeof m.map !== "function") throw new Error("无效的下载源: " + String(m)); }
  return list.length ? list : resolveMirrors(undefined);
}

export function resolveMirrors(ids) {
  const list = (ids && ids.length ? ids : ["official", "bmclapi"]).map((id) => {
    const m = MIRRORS[id];
    if (!m) throw new Error("未知镜像: " + id + "（可用: " + Object.keys(MIRRORS).join(", ") + "）");
    return m;
  });
  return list;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha1");
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

export async function statOrNull(p) {
  try { return await fsp.stat(p); } catch { return null; }
}

export function humanSize(n) {
  if (n == null) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + " " + u[i];
}

export function humanTime(sec) {
  if (!isFinite(sec) || sec < 0) return "--:--";
  sec = Math.round(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

/* ------------------------------------------------------------------ */
/* 进度条                                                              */
/* ------------------------------------------------------------------ */

export class Progress {
  constructor(label, total = 0) {
    this.label = label;
    this.total = total;
    this.done = 0;
    this.bytes = 0;
    this.bytesBase = 0;
    this.t0 = Date.now();
    this.lastRender = 0;
    this.lastBytes = 0;
    this.lastT = Date.now();
    this.speed = 0;
    this.current = "";
    this.enabled = process.stderr.isTTY === true;
  }
  add(n = 1) { this.done += n; this.render(); }
  skip(bytes = 0) { this.done += 1; this.bytes += bytes; this.render(); }
  data(n) {
    this.bytes += n;
    const now = Date.now();
    if (now - this.lastT > 500) {
      this.speed = ((this.bytes - this.lastBytes) / (now - this.lastT)) * 1000;
      this.lastBytes = this.bytes;
      this.lastT = now;
      this.render();
    }
  }
  note(name) { this.current = name; }
  render(force = false) {
    const now = Date.now();
    if (!force && now - this.lastRender < 120) return;
    this.lastRender = now;
    const pct = this.total ? Math.min(1, this.done / this.total) : 1;
    const elapsed = (now - this.t0) / 1000;
    const eta = this.done > 0 ? (elapsed / this.done) * (this.total - this.done) : NaN;
    const line =
      "[" + "█".repeat(Math.round(pct * 20)).padEnd(20, "·") + "] " +
      String(this.done).padStart(5) + "/" + String(this.total || "?").padEnd(5) +
      " " + String(Math.round(pct * 100)).padStart(3) + "%" +
      "  " + humanSize(this.bytes).padStart(9) +
      (this.speed ? "  " + humanSize(this.speed) + "/s" : "") +
      "  ETA " + humanTime(eta) +
      (this.current ? "  " + this.current.slice(0, 40) : "");
    if (this.enabled) process.stderr.write("\r" + line.slice(0, 170).padEnd(120, " "));
  }
  finish() {
    this.render(true);
    if (this.enabled) process.stderr.write("\n");
  }
}

/* ------------------------------------------------------------------ */
/* 请求                                                                */
/* ------------------------------------------------------------------ */

export class HttpError extends Error {
  constructor(status, url) { super("HTTP " + status + " " + url); this.status = status; }
}

async function fetchOnce(url, { timeout = 30000, init = {} } = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": UA, ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeout),
    ...init,
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return res;
}

/** 依次尝试各镜像，返回 { data, url } */
export async function getJson(url, mirrors, { retries = 2, timeout = 30000, label = "" } = {}) {
  mirrors = toMirrors(mirrors);
  const errs = [];
  for (const m of mirrors) {
    const target = m.map(url);
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchOnce(target, { timeout });
        const data = await res.json();
        return { data, url: target };
      } catch (e) {
        errs.push(m.name + (attempt ? " 第" + (attempt + 1) + "次" : "") + ": " + (e && e.message));
        await sleep(250 * (attempt + 1));
      }
    }
  }
  throw new Error((label || "获取") + " 失败（所有镜像均不可用）：\n  " + errs.join("\n  "));
}

export async function getText(url, mirrors, opts) {
  mirrors = toMirrors(mirrors);
  const errs = [];
  for (const m of mirrors) {
    const target = m.map(url);
    for (let attempt = 0; attempt <= (opts && opts.retries ? opts.retries : 2); attempt++) {
      try {
        const res = await fetchOnce(target, { timeout: (opts && opts.timeout) || 30000 });
        return await res.text();
      } catch (e) {
        errs.push(m.name + ": " + (e && e.message));
        await sleep(200);
      }
    }
  }
  throw new Error("请求失败：\n  " + errs.join("\n  "));
}

/* ------------------------------------------------------------------ */
/* 文件下载                                                            */
/* ------------------------------------------------------------------ */

async function downloadOnce(url, tmp, { timeout = 30000, progress, signal }) {
  // 连接用 timeout 控制；开始收数据后改成「60 秒没有新数据」才算卡死，
  // 这样 20MB 的文件在慢速链路上也不会被总时长杀掉。
  const ctrl = new AbortController();
  let timer = null;
  if (signal) {
    if (signal.aborted) throw new Error("已取消");
    signal.addEventListener("abort", () => ctrl.abort(new Error("已取消")), { once: true });
  }
  const arm = (ms) => { if (timer) clearTimeout(timer); timer = setTimeout(() => ctrl.abort(new Error("连接超时")), ms); };
  arm(timeout);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": UA },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new HttpError(res.status, url);
    if (!res.body) throw new Error("响应为空");
    await fsp.mkdir(path.dirname(tmp), { recursive: true });
    arm(60000);
    const counter = new Transform({
      transform(chunk, _enc, cb) { arm(60000); progress && progress.data(chunk.length); cb(null, chunk); },
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 下载单个文件，带镜像回退、SHA1 校验、断点式跳过。
 * @returns {{skipped:boolean, url:string}}
 */
export async function downloadFile(opts) {
  const { url, dest, sha1, size, progress, timeout = 90000, retries = 2, verify = false, signal } = opts;
  const mirrors = toMirrors(opts.mirrors);
  if (signal && signal.aborted) throw new Error("已取消");
  const st = await statOrNull(dest);
  if (st && st.isFile()) {
    const sizeOk = size == null || st.size === size;
    if (sizeOk && !verify) { progress && progress.skip(st.size); return { skipped: true, url: dest }; }
    if (sizeOk && verify && sha1) {
      const h = await sha1File(dest);
      if (h === sha1) { progress && progress.skip(st.size); return { skipped: true, url: dest }; }
    }
    // 大小不符 → 重新下载
  }

  const tmp = dest + ".mcdl-part";
  const errs = [];
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  for (const m of mirrors) {
    const target = m.map(url);
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await downloadOnce(target, tmp, { timeout, progress, signal });
        const got = await statOrNull(tmp);
        if (!got) throw new Error("下载后文件不存在");
        if (size != null && got.size !== size) throw new Error("大小不符 " + got.size + "/" + size);
        if (sha1) {
          const h = await sha1File(tmp);
          if (h !== sha1) throw new Error("SHA1 校验失败");
        }
        await fsp.rename(tmp, dest);
        progress && progress.add();
        return { skipped: false, url: target };
      } catch (e) {
        try { await fsp.rm(tmp, { force: true }); } catch {}
        errs.push(m.name + " 第" + (attempt + 1) + "次: " + (e && (e.message || e.name)));
        if (e instanceof HttpError && e.status === 404) break; // 该镜像没有此文件，换下一个
        await sleep(300 * (attempt + 1));
      }
    }
  }
  throw new Error("下载失败: " + url + "\n  " + errs.join("\n  "));
}

/** 并发池 */
export async function pMap(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------ */
/* 事件型进度：给 Electron / CLI 用，节流后回调出去                      */
/* ------------------------------------------------------------------ */

export class EmitterProgress {
  constructor(label, total, emit) {
    this.label = label;
    this.total = total;
    this.done = 0;
    this.bytes = 0;
    this.t0 = Date.now();
    this.last = 0;
    this.lastBytes = 0;
    this.lastT = Date.now();
    this.speed = 0;
    this.current = "";
    this.emit = emit || (() => {});
  }
  push(force) {
    const now = Date.now();
    if (!force && now - this.last < 120) return;
    this.last = now;
    this.emit({
      label: this.label,
      done: this.done,
      total: this.total,
      bytes: this.bytes,
      speed: this.speed,
      current: this.current,
      elapsed: Math.round((now - this.t0) / 1000),
    });
  }
  add(n = 1) { this.done += n; this.push(); }
  skip(bytes = 0) { this.done += 1; this.bytes += bytes; this.push(); }
  data(n) {
    this.bytes += n;
    const now = Date.now();
    if (now - this.lastT > 500) {
      this.speed = ((this.bytes - this.lastBytes) / (now - this.lastT)) * 1000;
      this.lastBytes = this.bytes;
      this.lastT = now;
      this.push();
    }
  }
  note(name) { this.current = name; this.push(); }
  finish() { this.push(true); }
}