import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 表情包清单同步：扫描 stickers/，把未登记的新图补进 manifest.json，并诊断坏条目。
 *
 * - 只增不改：已有条目原样保留，名称与描述不会被覆盖
 * - 新条目：名称取文件名、描述留空（可稍后手补）；id 优先用文件名，中文名生成稳定短 id
 * - 诊断：清单里指向缺失 / 空 / 超 8MiB 文件的条目会被列出（这类条目运行时会被静默忽略）
 * 用法：npm run stickers:sync
 */

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 与 src/stickers.ts 保持一致
const EXT_RE = /\.(?:png|jpe?g|gif)$/i;
const ID_RE = /^[a-z0-9_-]+$/;

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(path.resolve(here, ".."), "stickers");
const manifestPath = path.join(dir, "manifest.json");

if (!existsSync(dir)) {
  console.error(`stickers/ 目录不存在：${dir}`);
  process.exit(1);
}

interface Entry {
  id: string;
  file: string;
  name: string;
  description: string;
}

let entries: Entry[] = [];
if (existsSync(manifestPath)) {
  let raw: { version?: unknown; stickers?: unknown };
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof raw;
  } catch {
    console.error("manifest.json 不是合法 JSON，先手动修好再跑同步（不会覆盖现有文件）。");
    process.exit(1);
  }
  if (raw?.version !== 1 || !Array.isArray(raw.stickers)) {
    console.error("manifest.json 结构不是 { version: 1, stickers: [...] }，先手动修好再跑同步（不会覆盖现有文件）。");
    process.exit(1);
  }
  entries = raw.stickers as Entry[];
}

const usedIds = new Set(entries.map((e) => String(e?.id ?? "")));
const knownFiles = new Set(entries.map((e) => String(e?.file ?? "")));

function uniqueId(base: string): string {
  let id = base;
  for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
  usedIds.add(id);
  return id;
}

// ── 扫描目录：未登记的图片补条目 ──
const added: string[] = [];
const skipped: string[] = [];
for (const d of readdirSync(dir, { withFileTypes: true })) {
  if (!d.isFile() || !EXT_RE.test(d.name) || knownFiles.has(d.name)) continue;
  const size = statSync(path.join(dir, d.name)).size;
  if (size === 0 || size > MAX_FILE_BYTES) {
    skipped.push(`  - ${d.name}：${(size / 1024 / 1024).toFixed(1)} MiB（空文件或超 8 MiB），未登记`);
    continue;
  }
  const stem = d.name.slice(0, -path.extname(d.name).length);
  const base = ID_RE.test(stem.toLowerCase())
    ? stem.toLowerCase()
    : "f" + createHash("sha1").update(d.name).digest("hex").slice(0, 8);
  const id = uniqueId(base);
  entries.push({ id, file: d.name, name: stem, description: "" });
  knownFiles.add(d.name);
  added.push(`  + ${d.name} → id=${id}（名称「${stem}」，描述未填）`);
}

// ── 诊断：清单里运行时会被静默忽略的条目 ──
const broken: string[] = [];
for (const e of entries) {
  const file = String(e?.file ?? "");
  if (!file) {
    broken.push(`  - id=${e?.id ?? "?"}：file 为空`);
    continue;
  }
  const p = path.join(dir, file);
  if (!EXT_RE.test(file) || !existsSync(p)) {
    broken.push(`  - id=${e.id}（file=${file}）：文件不在 stickers/ 里`);
    continue;
  }
  const size = statSync(p).size;
  if (size === 0 || size > MAX_FILE_BYTES) {
    broken.push(`  - id=${e.id}（file=${file}）：${(size / 1024 / 1024).toFixed(1)} MiB，空文件或超 8 MiB`);
  }
}

if (added.length) {
  writeFileSync(manifestPath, JSON.stringify({ version: 1, stickers: entries }, null, 2) + "\n");
  console.log(`已把 ${added.length} 张新图补进清单：`);
  console.log(added.join("\n"));
  console.log("想让模型挑得更准，可给这些条目补 description（什么场景用哪张）——清单热读取，保存即生效，不用重启。");
} else {
  console.log("没有未登记的新图，清单已是最新。");
}
if (skipped.length) {
  console.log("\n跳过（规格不符，未登记）：");
  console.log(skipped.join("\n"));
}
if (broken.length) {
  console.log("\n注意：以下清单条目运行时会被静默忽略，请修正或删除：");
  console.log(broken.join("\n"));
}
