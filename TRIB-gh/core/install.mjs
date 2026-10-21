// 安装（下载）一个原版版本到指定 .minecraft
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { downloadFile, getJson, pMap, Progress, humanSize, statOrNull } from "./net.mjs";
import { fetchManifest, findVersionEntry, fetchVersionJson, resolveLibraries, OS_NAME } from "./mc.mjs";
import { extractZip, makeExcluder } from "./zip.mjs";

const ASSET_BASE = "https://resources.download.minecraft.net/";

/** 批量下载：单个失败不影响其它；全部跑完后再降并发重试一轮 */
async function downloadBatch(items, threads, run, label) {
  const failed = [];
  await pMap(items, threads, async (it) => {
    try { await run(it); } catch (e) { failed.push({ it, e }); }
  });
  if (!failed.length) return;
  const still = [];
  await pMap(failed, Math.max(2, Math.floor(threads / 8)), async (f) => {
    try { await run(f.it); } catch (e) { still.push(f); }
  });
  if (still.length) {
    throw new Error(
      label + " 有 " + still.length + "/" + items.length + " 个文件没下下来：" + String.fromCharCode(10) +
      still.slice(0, 6).map((f) => "  - " + String(f.e.message).split(String.fromCharCode(10))[0]).join(String.fromCharCode(10)) +
      String.fromCharCode(10) + "  可以重新执行同一条命令继续（已下好的会跳过），或加 --mirror bmclapi 换源。"
    );
  }
}

export async function installVersion(opts) {
  const {
    versionId, dir, mirrors, verify = false, threads = 16,
    features = {}, log = console.log, signal,
  } = opts;
  const t0 = Date.now();

  log("› 正在获取版本清单…");
  const manifest = await fetchManifest(mirrors);
  const entry = await findVersionEntry(manifest, versionId);
  log("› 目标版本: " + entry.id + "  (" + entry.type + ")");

  const vjson = await fetchVersionJson(entry, mirrors);
  const versionDir = path.join(dir, "versions", vjson.id);
  await fsp.mkdir(versionDir, { recursive: true });
  await fsp.writeFile(path.join(versionDir, vjson.id + ".json"), JSON.stringify(vjson, null, 2), "utf8");

  /* ---------- 计划 ---------- */
  const libs = resolveLibraries(vjson, features);
  const client = vjson.downloads && vjson.downloads.client;
  const natives = libs.filter((l) => l.kind === "native");

  let assetObjects = [];
  let assetIndexId = null;
  if (vjson.assetIndex && vjson.assetIndex.url) {
    assetIndexId = vjson.assetIndex.id;
    const indexFile = path.join(dir, "assets", "indexes", assetIndexId + ".json");
    const st = await statOrNull(indexFile);
    if (!st) {
      await downloadFile({
        url: vjson.assetIndex.url, dest: indexFile, sha1: vjson.assetIndex.sha1,
        size: vjson.assetIndex.size, mirrors, verify, progress: null,
      });
    }
    const idx = JSON.parse(await fsp.readFile(indexFile, "utf8"));
    assetObjects = Object.entries(idx.objects || {}).map(([name, o]) => ({ name, hash: o.hash, size: o.size }));
    vjson.__assetIndexJson = idx;
  }

  const logCfg = vjson.logging && vjson.logging.client && vjson.logging.client.file;

  const total = 1 + (client ? 1 : 0) + libs.length + (assetIndexId ? assetObjects.length : 0) + (logCfg ? 1 : 0);
  const makeProgress = opts.progressFactory || ((label, t) => new Progress(label, t));
  const bar = makeProgress("下载 " + vjson.id, total);
  log("› 需要下载: 客户端 1 个 / 依赖库 " + libs.length + " 个 / 资源文件 " + assetObjects.length + " 个" +
      (logCfg ? " / 日志配置 1 个" : ""));

  /* ---------- 客户端 jar ---------- */
  if (client) {
    await downloadFile({
      url: client.url, dest: path.join(versionDir, vjson.id + ".jar"),
      sha1: client.sha1, size: client.size, mirrors, progress: bar, verify, signal, signal,
    });
  } else {
    bar.skip();
  }

  /* ---------- 依赖库 ---------- */
  const libBase = path.join(dir, "libraries");
  await downloadBatch(libs, threads, async (lib) => {
    await downloadFile({
      url: lib.url, dest: path.join(libBase, lib.path),
      sha1: lib.sha1 || null, size: lib.size || null, mirrors, progress: bar, verify, signal,
    });
  }, "依赖库");

  /* ---------- natives ---------- */
  if (natives.length) {
    const nativesDir = path.join(versionDir, "natives");
    await fsp.mkdir(nativesDir, { recursive: true });
    for (const n of natives) {
      const jarPath = path.join(libBase, n.path);
      const isExcluded = makeExcluder(n.exclude || ["META-INF/"]);
      const buf = await fsp.readFile(jarPath);
      let entries;
      try { entries = extractZip(buf, (name) => !isExcluded(name)); }
      catch (e) { log("!! 解压 natives 失败 " + n.name + ": " + e.message); continue; }
      for (const e of entries) {
        const outFile = path.join(nativesDir, e.name);
        await fsp.mkdir(path.dirname(outFile), { recursive: true });
        await fsp.writeFile(outFile, e.data);
      }
    }
  }

  /* ---------- 资源 ---------- */
  if (assetIndexId) {
    const objBase = path.join(dir, "assets", "objects");
    await downloadBatch(assetObjects, threads, async (o) => {
      await downloadFile({
        url: ASSET_BASE + o.hash.slice(0, 2) + "/" + o.hash,
        dest: path.join(objBase, o.hash.slice(0, 2), o.hash),
        sha1: o.hash, size: o.size, mirrors, progress: bar, verify, signal,
      });
    }, "资源文件");

    const idx = vjson.__assetIndexJson;
    if (idx && (idx.virtual || idx.map_to_resources)) {
      const root = idx.virtual ? path.join(dir, "assets", "virtual", assetIndexId) : path.join(dir, "resources");
      for (const o of assetObjects) {
        const src = path.join(objBase, o.hash.slice(0, 2), o.hash);
        const dst = path.join(root, o.name.split("/").join(path.sep));
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.copyFile(src, dst).catch(() => {});
      }
      log("› 已展开旧版资源到 " + root);
    }
  }

  /* ---------- 日志配置 ---------- */
  if (logCfg) {
    await downloadFile({
      url: logCfg.url, dest: path.join(dir, "assets", "log_configs", logCfg.id),
      sha1: logCfg.sha1, size: logCfg.size, mirrors, progress: bar, verify, signal,
    });
  }

  bar.finish();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log("✓ " + vjson.id + " 安装完成，用时 " + secs + " 秒，位置: " + versionDir);
  return vjson;
}