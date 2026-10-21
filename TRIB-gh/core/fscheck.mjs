// 已安装版本的检查与修复：列期望文件、找缺失、补下载
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getJson, downloadFile, pMap, statOrNull, sha1File } from "./net.mjs";
import { resolveLibraries } from "./mc.mjs";
import { loadVersionTree } from "./launch.mjs";

const ASSET_BASE = "https://resources.download.minecraft.net/";

/** 收集一个版本（含继承链）应当存在的全部文件 */
export async function collectExpected(dir, id) {
  const { merged, jarId } = await loadVersionTree(dir, id);
  const files = [];

  const client = merged.downloads && merged.downloads.client;
  if (client) {
    files.push({
      kind: "client",
      file: path.join(dir, "versions", jarId, jarId + ".jar"),
      url: client.url, sha1: client.sha1, size: client.size,
    });
  }

  for (const lib of resolveLibraries(merged, {})) {
    if (lib.kind === "native") continue;
    files.push({
      kind: "lib",
      file: path.join(dir, "libraries", lib.path),
      url: lib.url, sha1: lib.sha1 || null, size: lib.size || null,
      name: lib.name,
    });
  }

  const logs = merged.logging && merged.logging.client && merged.logging.client.file;
  if (logs) {
    files.push({
      kind: "log",
      file: path.join(dir, "assets", "log_configs", logs.id),
      url: logs.url, sha1: logs.sha1, size: logs.size,
    });
  }

  let assets = null;
  const ai = merged.assetIndex;
  if (ai && ai.url) {
    const indexFile = path.join(dir, "assets", "indexes", ai.id + ".json");
    let index = null;
    try { index = JSON.parse(await fsp.readFile(indexFile, "utf8")); } catch { /* 缺索引 */ }
    assets = { id: ai.id, indexFile, indexUrl: ai.url, indexSha1: ai.sha1, indexSize: ai.size, objects: [] };
    if (index && index.objects) {
      for (const [name, o] of Object.entries(index.objects)) {
        assets.objects.push({
          file: path.join(dir, "assets", "objects", o.hash.slice(0, 2), o.hash),
          url: ASSET_BASE + o.hash.slice(0, 2) + "/" + o.hash,
          sha1: o.hash, size: o.size, name,
        });
      }
    }
  }

  return { merged, jarId, files, assets };
}

/** 检查：默认只比大小（快），deep=true 时逐个算 SHA1（慢） */
export async function checkVersion(dir, id, opts = {}) {
  const deep = !!opts.deep;
  const skipAssets = !!opts.skipAssets;
  const { merged, files, assets } = await collectExpected(dir, id);
  const missing = [];
  const broken = [];
  let totalFiles = files.length;
  let totalBytes = 0;
  for (const f of files) totalBytes += f.size || 0;

  for (const f of files) {
    const st = await statOrNull(f.file);
    if (!st) { missing.push({ kind: f.kind, name: f.name || f.kind, file: f.file }); continue; }
    if (f.size != null && st.size !== f.size) { broken.push({ kind: f.kind, name: f.name || f.kind, file: f.file, reason: "大小不符" }); continue; }
    if (deep && f.sha1) {
      const h = await sha1File(f.file);
      if (h !== f.sha1) broken.push({ kind: f.kind, name: f.name || f.kind, file: f.file, reason: "SHA1 不符" });
    }
  }

  if (assets && !skipAssets) {
    totalFiles += assets.objects.length + 1;
    const st = await statOrNull(assets.indexFile);
    if (!st) missing.push({ kind: "assetIndex", name: assets.id, file: assets.indexFile });
    for (const o of assets.objects) {
      totalBytes += o.size || 0;
      const s = await statOrNull(o.file);
      if (!s) { missing.push({ kind: "asset", name: o.name, file: o.file }); continue; }
      if (o.size != null && s.size !== o.size) broken.push({ kind: "asset", name: o.name, file: o.file, reason: "大小不符" });
      else if (deep && o.sha1) {
        const h = await sha1File(o.file);
        if (h !== o.sha1) broken.push({ kind: "asset", name: o.name, file: o.file, reason: "SHA1 不符" });
      }
    }
  }

  return {
    id, ok: missing.length === 0 && broken.length === 0,
    totalFiles, totalBytes,
    java: (merged.javaVersion && merged.javaVersion.majorVersion) || 8,
    type: merged.type || "release",
    missing, broken,
  };
}

/** 修复：只补缺的/坏的，顺序与原版安装一致 */
export async function repairVersion(dir, id, opts = {}) {
  const { mirrors, threads = 16, onEvent } = opts;
  const report = await checkVersion(dir, id, { deep: false });
  const todo = [...report.missing, ...report.broken];
  if (!todo.length) return { repaired: 0, report };

  const { files, assets } = await collectExpected(dir, id);
  const byFile = new Map();
  for (const f of files) byFile.set(f.file, f);
  if (assets) {
    byFile.set(assets.indexFile, { url: assets.indexUrl, sha1: assets.indexSha1, size: assets.indexSize });
    for (const o of assets.objects) byFile.set(o.file, o);
  }

  let done = 0;
  const total = todo.length;
  await pMap(todo, threads, async (item) => {
    const meta = byFile.get(item.file);
    if (!meta || !meta.url) return;
    try {
      await downloadFile({
        url: meta.url, dest: item.file, sha1: meta.sha1 || null, size: meta.size || null,
        mirrors, verify: false,
      });
    } catch (e) {
      // 单个失败不影响其它，最后用 checkVersion 再报一次
    }
    done++;
    if (onEvent) onEvent({ done, total, file: item.name });
  });

  const after = await checkVersion(dir, id, { deep: false });
  return { repaired: total - (after.missing.length + after.broken.length), report: after };
}