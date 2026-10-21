// 版本元数据：规则求值、库解析、版本继承合并
import os from "node:os";
import { getJson } from "./net.mjs";

export const MANIFEST_URL = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";

export const OS_NAME = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";

const D = String.fromCharCode(36); // 避免模板里直接出现美元符号

export function osArch() {
  switch (process.arch) {
    case "x64": return "x86_64";
    case "ia32": return "x86";
    case "arm64": return "arm64";
    default: return process.arch;
  }
}
const ARCH_BITS = process.arch === "x86" ? "32" : "64";

/* ---------------- 规则 ---------------- */

function ruleMatches(rule, features) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== OS_NAME) return false;
    if (rule.os.arch && rule.os.arch !== osArch()) return false;
    if (rule.os.version) {
      try { if (!new RegExp(rule.os.version).test(os.release())) return false; } catch { /* 忽略非法正则 */ }
    }
  }
  if (rule.features) {
    for (const [k, v] of Object.entries(rule.features)) {
      if (Boolean(features && features[k]) !== v) return false;
    }
  }
  return true;
}

export function evaluateRules(rules, features = {}) {
  if (!rules || rules.length === 0) return true;
  let allow = false;
  for (const r of rules) {
    if (!ruleMatches(r, features)) continue;
    allow = r.action === "allow";
  }
  return allow;
}

/* ---------------- 版本清单 ---------------- */

export async function fetchManifest(mirrors) {
  const { data } = await getJson(MANIFEST_URL, mirrors, { label: "获取版本清单" });
  if (!data || !Array.isArray(data.versions)) throw new Error("版本清单格式异常");
  return data;
}

export async function findVersionEntry(manifest, id) {
  const v = manifest.versions.find((x) => x.id === id);
  if (!v) {
    const near = manifest.versions.filter((x) => x.id.toLowerCase().includes(String(id).toLowerCase())).slice(0, 8);
    throw new Error(
      "版本清单里没有 “" + id + "”" +
      (near.length ? "。你是不是想找：" + near.map((x) => x.id).join(", ") : "")
    );
  }
  return v;
}

export async function fetchVersionJson(entry, mirrors) {
  const { data } = await getJson(entry.url, mirrors, { label: "获取 " + entry.id + " 的版本信息" });
  if (!data || !data.id) throw new Error("版本 JSON 格式异常: " + entry.id);
  return data;
}

/* ---------------- 继承合并 ---------------- */

function dedupeLibraries(list) {
  const seen = new Set();
  const out = [];
  for (const lib of list) {
    const key = lib.name + "|" + JSON.stringify(lib.natives || null) + "|" + ((lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path) || "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(lib);
  }
  return out;
}

export function mergeVersions(parent, child) {
  const merged = { ...parent, ...child };
  merged.libraries = dedupeLibraries([...(parent.libraries || []), ...(child.libraries || [])]);
  merged.arguments = {
    jvm: [...((parent.arguments && parent.arguments.jvm) || []), ...((child.arguments && child.arguments.jvm) || [])],
    game: [...((parent.arguments && parent.arguments.game) || []), ...((child.arguments && child.arguments.game) || [])],
  };
  merged.minecraftArguments = child.minecraftArguments ?? parent.minecraftArguments;
  merged.downloads = { ...(parent.downloads || {}), ...(child.downloads || {}) };
  merged.assetIndex = child.assetIndex ?? parent.assetIndex;
  merged.assets = child.assets ?? parent.assets;
  merged.javaVersion = child.javaVersion ?? parent.javaVersion;
  merged.logging = child.logging ?? parent.logging;
  merged.mainClass = child.mainClass ?? parent.mainClass;
  merged.id = child.id;
  return merged;
}

/* ---------------- Maven 坐标 ---------------- */

export function mavenPath(name) {
  const parts = String(name).split(":");
  if (parts.length < 3) return null;
  const group = parts[0], artifact = parts[1], version = parts[2], classifier = parts[3];
  const file = artifact + "-" + version + (classifier ? "-" + classifier : "") + ".jar";
  return group.replace(/\./g, "/") + "/" + artifact + "/" + version + "/" + file;
}

/* ---------------- 库解析 ---------------- */

/**
 * 返回本机需要落盘 / 上 classpath 的库。
 * kind: "lib" 普通库 | "native" 需要解压的本地库
 */
export function resolveLibraries(version, features = {}) {
  const out = [];
  for (const lib of version.libraries || []) {
    if (lib.rules && !evaluateRules(lib.rules, features)) continue;

    if (lib.natives) {
      const rawKey = lib.natives[OS_NAME];
      if (!rawKey) continue;
      const key = rawKey.replace(D + "{arch}", ARCH_BITS);
      const cls = lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[key];
      if (cls) {
        out.push({
          kind: "native", name: lib.name, classifier: key,
          path: cls.path, url: cls.url, sha1: cls.sha1, size: cls.size,
          exclude: lib.extract && lib.extract.exclude,
        });
      }
      continue;
    }

    const art = lib.downloads && lib.downloads.artifact;
    if (art) {
      out.push({ kind: "lib", name: lib.name, path: art.path, url: art.url, sha1: art.sha1, size: art.size });
      continue;
    }
    if (lib.name && lib.url) {
      const p = mavenPath(lib.name);
      if (p) out.push({ kind: "lib", name: lib.name, path: p, url: lib.url.replace(/\/?$/, "/") + p, sha1: null, size: null });
    }
  }
  return out;
}

export function describeVersion(v) {
  return v.id + "  [" + v.type + "]" + (v.releaseTime ? "  " + v.releaseTime.slice(0, 10) : "");
}
