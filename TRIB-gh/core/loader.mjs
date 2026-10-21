// 加载器安装：NeoForge / Forge（官方安装器）与 Fabric（元数据直接组装）
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { downloadFile, getJson, getText, statOrNull, pMap } from "./net.mjs";
import { resolveLibraries } from "./mc.mjs";
import { findJava } from "./java.mjs";

const NEOFORGE_BASE = "https://maven.neoforged.net/releases/net/neoforged/neoforge";
const FORGE_BASE = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const FABRIC_META = "https://meta.fabricmc.net/v2";

function parseSpec(loader) {
  const [kind, ...rest] = String(loader).split(":");
  return { kind: kind.toLowerCase(), version: rest.join(":") || null };
}

function runJava(exe, args, cwd, log) {
  return new Promise((resolve, reject) => {
    log("› " + path.basename(exe) + " " + args.map((a) => (/[\s]/.test(a) ? '"' + a + '"' : a)).join(" "));
    const child = spawn(exe, args, { cwd, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("安装器退出码 " + code))));
  });
}

function cmpVersion(a, b) {
  const pa = a.split(/[.\-+]/), pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] === undefined ? 0 : Number(pa[i].replace(/\D/g, "") || 0);
    const y = pb[i] === undefined ? 0 : Number(pb[i].replace(/\D/g, "") || 0);
    if (x !== y) return x - y;
  }
  return 0;
}

/** 从 maven-metadata.xml 里挑最新版 */
async function latestFromMaven(baseUrl, mirrors, prefix) {
  const xml = await getText(baseUrl + "/maven-metadata.xml", mirrors, { timeout: 20000 });
  const all = [...String(xml).matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  const pool = prefix ? all.filter((v) => v.startsWith(prefix)) : all;
  if (!pool.length) throw new Error("没有找到匹配 " + prefix + " 的版本");
  return pool.sort(cmpVersion).pop();
}

export async function installLoader({ loader, mcVersion, dir, mirrors, java, log = console.log }) {
  const { kind, version } = parseSpec(loader);

  if (kind === "fabric") return installFabric({ version, mcVersion, dir, mirrors, log });
  if (kind !== "neoforge" && kind !== "forge") {
    throw new Error("暂不支持 " + kind + "（可用: neoforge / forge / fabric）");
  }

  const parts = String(mcVersion).split(".");
  const major = Number(parts[1] || 0), minor = Number(parts[2] || 0);

  let ver = version, url;
  if (kind === "neoforge") {
    if (!ver) {
      const prefix = major + "." + minor + ".";
      ver = await latestFromMaven(NEOFORGE_BASE, mirrors, prefix);
      log("› 自动选择 NeoForge 版本: " + ver);
    }
    url = NEOFORGE_BASE + "/" + ver + "/neoforge-" + ver + "-installer.jar";
  } else {
    if (!ver) {
      ver = await latestFromMaven(FORGE_BASE, mirrors, mcVersion + "-");
      log("› 自动选择 Forge 版本: " + ver);
    }
    const full = ver.startsWith(mcVersion + "-") ? ver : mcVersion + "-" + ver;
    url = FORGE_BASE + "/" + full + "/forge-" + full + "-installer.jar";
  }

  const tmpDir = path.join(dir, "downloads", "mcdl");
  await fsp.mkdir(tmpDir, { recursive: true });
  const jar = path.join(tmpDir, (kind === "neoforge" ? "neoforge-" + ver : "forge-" + ver) + "-installer.jar");

  log("› 下载安装器: " + url);
  await downloadFile({ url, dest: jar, mirrors, retries: 2, timeout: 180000 });

  const jv = await findJava({ requiredMajor: 17, gameDir: dir, explicit: java });
  log("› 使用 Java: " + jv.exe + " (" + jv.raw + ")");
  log("› 提示: 安装器要访问 maven.neoforged.net / maven.minecraftforge.net。" + NL +
      "  如果这两个域名在你的网络里解析不了（DNS 污染），安装会超时失败。" + NL +
      "  这种情况请用 PCL 安装 NeoForge/Forge（PCL 走 BMCLAPI 镜像），再用 mcdl launch 启动。");

  const args = ["-jar", jar, "--installClient", dir];
  try {
    await runJava(jv.exe, args, dir, log);
  } catch (e) {
    log("!! 带路径的安装方式失败，改用默认目录重试…");
    await runJava(jv.exe, ["-jar", jar, "--installClient"], dir, log);
  }

  // 结果校验
  const versionsDir = path.join(dir, "versions");
  const names = await fsp.readdir(versionsDir).catch(() => []);
  const hit = names.filter((n) => n.toLowerCase().includes(kind === "neoforge" ? "neoforge" : "forge"));
  log("✓ 安装器执行完毕，当前含 " + (kind === "neoforge" ? "NeoForge" : "Forge") + " 的版本目录: " + (hit.join(", ") || "（无）"));
  if (!hit.length) throw new Error("安装器没有产出任何版本目录，请检查上面的安装器输出");
  return { version: ver, dirs: hit };
}

async function installFabric({ version, mcVersion, dir, mirrors, log }) {
  log("› 获取 Fabric 元数据…");
  let loaderVer = version;
  if (!loaderVer) {
    const { data } = await getJson(FABRIC_META + "/versions/loader/" + encodeURIComponent(mcVersion), mirrors, { label: "Fabric 加载器列表" });
    if (!Array.isArray(data) || !data.length) throw new Error("Fabric 还没有支持 " + mcVersion + " 的加载器");
    loaderVer = data[0].loader.version;
  }
  const profileUrl = FABRIC_META + "/versions/loader/" + encodeURIComponent(mcVersion) + "/" + encodeURIComponent(loaderVer) + "/profile/json";
  const { data: profile } = await getJson(profileUrl, mirrors, { label: "Fabric 版本描述" });

  const id = profile.id;
  const vdir = path.join(dir, "versions", id);
  await fsp.mkdir(vdir, { recursive: true });
  await fsp.writeFile(path.join(vdir, id + ".json"), JSON.stringify(profile, null, 2), "utf8");
  log("› 已写入 versions/" + id + "/" + id + ".json");

  const libs = resolveLibraries(profile, {});
  log("› 下载 Fabric 依赖 " + libs.length + " 个…");
  let err = null;
  await pMap(libs, 12, async (l) => {
    if (err) return;
    try {
      await downloadFile({ url: l.url, dest: path.join(dir, "libraries", l.path), sha1: l.sha1 || null, size: l.size || null, mirrors });
    } catch (e) { err = e; }
  });
  if (err) throw err;
  log("✓ Fabric " + loaderVer + " 安装完成，版本名: " + id);
  return { version: loaderVer, dirs: [id] };
}
/** 列出某个加载器对某 MC 版本可用的版本号（给 UI 用） */
export async function listLoaderVersions({ loader, mc, mirrors, limit = 30 }) {
  const { kind } = parseSpec(loader);

  if (kind === "fabric") {
    const { data } = await getJson(FABRIC_META + "/versions/loader/" + encodeURIComponent(mc), mirrors, { label: "Fabric 版本列表" });
    return (data || []).slice(0, limit).map((d) => ({
      version: d.loader.version, stable: d.loader.stable !== false, date: "",
    }));
  }

  if (kind === "neoforge") {
    const parts = String(mc).split(".");
    const prefix = Number(parts[1]) + "." + Number(parts[2] || 0) + ".";
    const xml = await getText(NEOFORGE_BASE + "/maven-metadata.xml", mirrors, { timeout: 20000 });
    const all = [...String(xml).matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
    return all.filter((v) => v.startsWith(prefix))
      .sort((a, b) => cmpVersion(a, b)).reverse()
      .slice(0, limit).map((v) => ({ version: v, stable: !/beta/i.test(v), date: "" }));
  }

  // forge
  const xml = await getText(FORGE_BASE + "/maven-metadata.xml", mirrors, { timeout: 30000 });
  const all = [...String(xml).matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  const pool = all.filter((v) => v.startsWith(mc + "-"));
  return pool.sort((a, b) => cmpVersion(a.split("-").pop(), b.split("-").pop())).reverse()
    .slice(0, limit).map((v) => ({ version: v.split("-").pop(), stable: true, date: "" }));
}
