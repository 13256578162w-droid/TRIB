// 极简 ZIP 读取器：只为解压 natives（store / deflate）
import zlib from "node:zlib";

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

export function listZip(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error("不是有效的 ZIP 文件");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, size, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readEntry(buf, entry) {
  const lo = entry.localOffset;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error("损坏的 ZIP 条目: " + entry.name);
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error("不支持的压缩方式 " + entry.method + ": " + entry.name);
}

export function extractZip(buf, filter) {
  const out = [];
  for (const e of listZip(buf)) {
    if (e.name.endsWith("/")) continue;
    if (filter && !filter(e.name)) continue;
    out.push({ name: e.name, data: readEntry(buf, e) });
  }
  return out;
}

export function makeExcluder(patterns) {
  if (!patterns || !patterns.length) return () => false;
  const regs = patterns.map((p) => {
    const src = String(p).replace(/[.+^$|{}\[\]()]/g, (m) => "\\" + m).replace(/\*/g, ".*");
    return new RegExp("^" + src + "$", "i");
  });
  return (name) => regs.some((r) => r.test(name));
}
