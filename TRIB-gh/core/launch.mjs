// 组装并执行启动命令
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { evaluateRules, resolveLibraries, mergeVersions } from "./mc.mjs";
import { findJava } from "./java.mjs";
import { statOrNull } from "./net.mjs";
import { extractZip, makeExcluder } from "./zip.mjs";

const D = String.fromCharCode(36);

export async function loadVersionTree(dir, id) {
  const chain = [];
  let cur = id;
  const seen = new Set();
  while (cur) {
    if (seen.has(cur)) throw new Error("版本继承出现循环: " + cur);
    seen.add(cur);
    const file = path.join(dir, "versions", cur, cur + ".json");
    let raw;
    try { raw = await fsp.readFile(file, "utf8"); }
    catch { throw new Error("找不到版本文件: " + file + "（先用 install 装一下，或检查 --dir）"); }
    chain.push(JSON.parse(raw));
    cur = chain[chain.length - 1].inheritsFrom;
  }
  let merged = chain[chain.length - 1];
  for (let i = chain.length - 2; i >= 0; i--) merged = mergeVersions(merged, chain[i]);
  const jarOwner = chain.find((v) => v.downloads && v.downloads.client) || chain[chain.length - 1];
  return { merged, chain, jarId: jarOwner.id };
}

function offlineUuid(name) {
  const md5 = crypto.createHash("md5").update("OfflinePlayer:" + name, "utf8").digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const h = md5.toString("hex");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
}

function substitute(str, ctx) {
  return String(str).replace(/\$\{([^}]+)\}/g, (all, key) => {
    const v = ctx[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

function flattenArgSpec(specs, features) {
  const out = [];
  for (const item of specs || []) {
    if (typeof item === "string") { out.push(item); continue; }
    if (!item) continue;
    if (item.rules && !evaluateRules(item.rules, features)) continue;
    if (Array.isArray(item.value)) out.push(...item.value);
    else if (item.value != null) out.push(item.value);
  }
  return out;
}

export async function buildCommand(opts) {
  const {
    versionId, dir, username = "Steve", memory = "4G", minMemory = "512M",
    extraJvm = [], width = null, height = null, javaPath = null,
    offline = true, uuid = null, accessToken = "0", userType = "msa",
    features = {}, dryRun = false, log = console.log,
  } = opts;

  const { merged, jarId } = await loadVersionTree(dir, versionId);
  const featuresAll = { has_custom_resolution: !!(width && height), ...features };
  const libs = resolveLibraries(merged, featuresAll);

  // 目录里含中文时，老版本 Java（8）会把命令行参数按控制台代码页解码，
  // 导致 classpath 里的路径变成乱码、找不到主类。这种情况下改用相对路径。
  const needRelative = /[^\x00-\x7f]/.test(dir);
  const rel = (p) => (needRelative ? path.relative(dir, p).split("\\").join("/") : p);

  const classpath = [];
  for (const l of libs) if (l.kind === "lib") classpath.push(rel(path.join(dir, "libraries", l.path)));
  classpath.push(rel(path.join(dir, "versions", jarId, jarId + ".jar")));

  const nativesDir = path.join(dir, "versions", merged.id, "natives");
  const natives = libs.filter((l) => l.kind === "native");
  if (natives.length) {
    await fsp.mkdir(nativesDir, { recursive: true });
    for (const n of natives) {
      const jar = path.join(dir, "libraries", n.path);
      const st = await statOrNull(jar);
      if (!st) continue;
      const marker = path.join(nativesDir, "." + path.basename(n.path));
      const old = await statOrNull(marker);
      if (old && old.mtimeMs >= st.mtimeMs) continue;
      const isExcluded = makeExcluder(n.exclude || ["META-INF/"]);
      try {
        for (const e of extractZip(await fsp.readFile(jar), (name) => !isExcluded(name))) {
          const outFile = path.join(nativesDir, e.name);
          await fsp.mkdir(path.dirname(outFile), { recursive: true });
          await fsp.writeFile(outFile, e.data);
        }
        await fsp.writeFile(marker, "");
      } catch (e) { log("!! 解压 natives 失败 " + n.name + ": " + e.message); }
    }
  }

  const assetsId = merged.assets || (merged.assetIndex && merged.assetIndex.id) || "legacy";
  const playerUuid = uuid || offlineUuid(username);

  const ctx = {
    auth_player_name: username,
    version_name: merged.id,
    game_directory: needRelative ? "." : dir,
    assets_root: rel(path.join(dir, "assets")),
    game_assets: rel(path.join(dir, "assets", "virtual", assetsId)),
    assets_index_name: assetsId,
    auth_uuid: playerUuid,
    auth_access_token: accessToken,
    auth_session: accessToken,
    clientid: "",
    auth_xuid: "",
    user_type: userType,
    version_type: merged.type || "release",
    user_properties: "{}",
    natives_directory: rel(nativesDir),
    launcher_name: "MCDL",
    launcher_version: "1.0",
    classpath: classpath.join(path.delimiter),
    classpath_separator: path.delimiter,
    library_directory: path.join(dir, "libraries"),
    resolution_width: width || 854,
    resolution_height: height || 480,
    quickPlayPath: "",
  };

  const jvmSpecs = (merged.arguments && merged.arguments.jvm) || [];
  let jvmArgs;
  if (jvmSpecs.length) {
    jvmArgs = flattenArgSpec(jvmSpecs, featuresAll);
  } else {
    jvmArgs = ["-Djava.library.path=" + D + "{natives_directory}", "-Dminecraft.launcher.brand=" + D + "{launcher_name}", "-Dminecraft.launcher.version=" + D + "{launcher_version}", "-cp", D + "{classpath}"];
  }
  if (!jvmArgs.includes("-cp") && !jvmArgs.includes("-classpath")) {
    jvmArgs.push("-cp", D + "{classpath}");
  }
  if (merged.logging && merged.logging.client) {
    const lf = merged.logging.client.file;
    const arg = (merged.logging.client.argument || "-Dlog4j.configurationFile=" + D + "{path}")
      .replace(D + "{path}", rel(path.join(dir, "assets", "log_configs", lf.id)));
    jvmArgs.unshift(arg);
  }

  const gameSpecs = (merged.arguments && merged.arguments.game) || [];
  let gameArgs;
  if (gameSpecs.length) {
    gameArgs = flattenArgSpec(gameSpecs, featuresAll);
  } else if (merged.minecraftArguments) {
    gameArgs = String(merged.minecraftArguments).split(/\s+/).filter(Boolean);
  } else {
    gameArgs = [];
  }

  const head = ["-Xmx" + memory, "-Xms" + minMemory, ...extraJvm];
  const resolved = [...head, ...jvmArgs, merged.mainClass, ...gameArgs].map((a) => substitute(a, ctx));

  const java = await findJava({
    requiredMajor: (merged.javaVersion && merged.javaVersion.majorVersion) || 8,
    gameDir: dir,
    explicit: javaPath,
  });

  return { exe: java.exe, java, args: resolved, cwd: dir, version: merged, dryRun };
}

export function quoteWin(arg) {
  if (!/[\s"]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '\\"') + '"';
}

export async function launch(opts) {
  const cmd = await buildCommand(opts);
  if (opts.dryRun) return cmd;
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd.exe, cmd.args, { cwd: cmd.cwd, stdio: "inherit", windowsHide: false });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ ...cmd, code }));
  });
}
