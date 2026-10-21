// Java 探测：按版本要求挑选合适的 JDK
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statOrNull } from "./net.mjs";

const run = promisify(execFile);
const JAVA_EXE = process.platform === "win32" ? "java.exe" : "java";

const COMMON_DIRS = [
  "C:\\Program Files\\Java",
  "C:\\Program Files\\Eclipse Adoptium",
  "C:\\Program Files\\Eclipse Foundation",
  "C:\\Program Files\\Microsoft",
  "C:\\Program Files\\Zulu",
  "C:\\Program Files\\BellSoft",
  "C:\\Program Files\\Amazon Corretto",
  "C:\\Program Files\\Semeru",
  "C:\\Program Files\\GraalVM",
  "C:\\Program Files (x86)\\Java",
];

export async function javaVersion(exe) {
  try {
    const r = await run(exe, ["-version"], { timeout: 15000, windowsHide: true });
    const text = String(r.stderr || "") + String(r.stdout || "");
    const m = text.match(/version "(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    const major = Number(m[1]) === 1 ? Number(m[2]) : Number(m[1]);
    return { major, raw: text.split(/\r?\n/)[0].trim() };
  } catch {
    return null;
  }
}

async function listSubdirs(dir) {
  try {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    return items.filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

export async function collectJavaCandidates(gameDir) {
  const found = [];
  const add = (p) => { if (p) found.push(p); };

  if (process.env.JAVA_HOME) add(path.join(process.env.JAVA_HOME, "bin", JAVA_EXE));

  try {
    const { stdout } = await run(process.platform === "win32" ? "where" : "which", ["java"], { timeout: 8000, windowsHide: true });
    for (const line of String(stdout).split(/\r?\n/)) if (line.trim()) add(line.trim());
  } catch { /* 没装 */ }

  for (const dir of COMMON_DIRS) {
    for (const sub of await listSubdirs(dir)) add(path.join(sub, "bin", JAVA_EXE));
  }

  if (gameDir) {
    for (const sub of await listSubdirs(path.join(gameDir, "runtime"))) add(path.join(sub, "bin", JAVA_EXE));
  }

  const seen = new Set();
  const uniq = [];
  for (const p of found) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (await statOrNull(p)) uniq.push(p);
  }
  return uniq;
}

export async function findJava({ requiredMajor = 8, gameDir, explicit } = {}) {
  if (explicit) {
    const v = await javaVersion(explicit);
    if (!v) throw new Error("指定的 Java 无法运行: " + explicit);
    return { exe: explicit, ...v };
  }
  const candidates = await collectJavaCandidates(gameDir);
  const metas = [];
  for (const c of candidates) {
    const v = await javaVersion(c);
    if (v) metas.push({ exe: c, ...v });
  }
  if (!metas.length) throw new Error("没有找到任何 Java，请安装 JDK 21 或使用 --java 指定路径");

  const ok = metas.filter((m) => m.major >= requiredMajor).sort((a, b) => a.major - b.major);
  if (ok.length) return ok[0];
  throw new Error("需要 Java " + requiredMajor + " 或更高，但只找到: " + metas.map((m) => m.major).join(", "));
}
