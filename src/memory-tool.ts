/**
 * remember / recall / forget 的桥接侧实现。
 *
 * 提问者只看本轮回环凭据绑上的 QQ。记忆文件按这个 QQ 分人存放。
 * 写入和删除仅院长；查询只打开提问者自己的档案。
 * 模型参数里的提问者 QQ 不进这个函数。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MEMORY_MAX_ENTRIES = 100;
export const MEMORY_MAX_TEXT = 200;
const SIMILAR_THRESHOLD = 0.7;

const IDENTITY_PATTERN =
  /(学号|班级|班号|姓名|名字|昵称|生日|出生|年龄|手机|电话|微信|邮箱|邮件|专业|学院|学校|导师|老师|导员|学籍|身份证|家庭|住址|地址|家乡|偏好|习惯|常用|喜欢|讨厌|最爱|爱吃|口味|不能吃|过敏|忌口|风格|时区|作息)/;

export interface MemEntry {
  id: string;
  t: string;
  text: string;
  pinned?: boolean;
}

export interface MemoryRequest {
  /** 桥接从 OneBot 事件绑定的提问者，不是模型参数。 */
  asker: string;
  owner: string;
  /** remember / recall / forget */
  op: unknown;
  text?: unknown;
  pinned?: unknown;
  query?: unknown;
  target?: unknown;
  now?: () => Date;
  id?: () => string;
}

export interface MemoryResult {
  ok: boolean;
  text: string;
}

function deny(text: string): MemoryResult {
  return { ok: false, text };
}

function bigrams(s: string): Set<string> {
  const t = s.replace(/[\s，。：；、！？,.:;!?()（）【】\[\]"'“”‘’]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function similarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / Math.min(A.size, B.size);
}

export function memoryFile(dir: string, userId: string): string {
  return path.join(dir, `${userId.replace(/[^0-9]/g, "") || "unknown"}.jsonl`);
}

export function loadMemory(dir: string, userId: string): MemEntry[] {
  const file = memoryFile(dir, userId);
  if (!existsSync(file)) return [];
  const out: MemEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as MemEntry;
      if (entry?.text) out.push(entry);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

export function saveMemory(dir: string, userId: string, entries: MemEntry[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(memoryFile(dir, userId), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function validQQ(asker: string): boolean {
  return /^[1-9]\d{4,19}$/.test(asker);
}

export function runMemory(input: MemoryRequest, dir: string): MemoryResult {
  const asker = String(input.asker ?? "").trim();
  if (!validQQ(asker)) return deny("QQ 号格式无效。");
  const owner = String(input.owner ?? "").trim();
  const op = String(input.op ?? "").trim();

  if (op === "recall") {
    const entries = loadMemory(dir, asker);
    if (entries.length === 0) return { ok: true, text: "长期记忆里还没有任何条目。" };
    const q = String(input.query ?? "").trim();
    const hit = q ? entries.filter((entry) => entry.text.includes(q)) : entries;
    if (hit.length === 0) return { ok: true, text: `没有找到含「${q}」的记忆条目（共 ${entries.length} 条）。` };
    const coreCount = entries.filter((entry) => entry.pinned).length;
    const lines = hit.map((entry) => `${entry.id}${entry.pinned ? "[核心]" : ""} | ${entry.text}`);
    return {
      ok: true,
      text: `长期记忆（共 ${entries.length} 条，其中核心 ${coreCount} 条；核心条目每次对话都会带上）：\n${lines.join("\n")}`,
    };
  }

  if (op !== "remember" && op !== "forget") return deny("未知记忆操作。");
  if (!owner || asker !== owner) {
    return deny(op === "forget" ? "只有院长可以删除记忆。" : "只有院长可以让我记住事情。");
  }

  if (op === "forget") {
    const target = String(input.target ?? "").trim();
    if (!target) return deny("要删除哪条？给我 id 或文本片段。");
    const entries = loadMemory(dir, asker);
    const hit = entries.filter((entry) => entry.id === target || entry.text.includes(target));
    if (hit.length === 0) return deny(`没有匹配「${target}」的记忆条目。`);
    const remain = entries.filter((entry) => !hit.includes(entry));
    saveMemory(dir, asker, remain);
    return { ok: true, text: `已删除 ${hit.length} 条：\n${hit.map((entry) => entry.text).join("\n")}\n（剩 ${remain.length} 条）` };
  }

  const raw = typeof input.text === "string" ? input.text.trim() : "";
  if (!raw) return deny("要记住的内容为空。");
  if (raw.length > MEMORY_MAX_TEXT) return deny(`内容太长（${raw.length} 字），请压缩到 ${MEMORY_MAX_TEXT} 字以内。`);

  const entries = loadMemory(dir, asker);
  const autoPin = IDENTITY_PATTERN.test(raw);
  const pinned = input.pinned === true || autoPin;
  const now = (input.now ?? (() => new Date()))().toISOString();

  const dup = entries.find((entry) => similarity(entry.text, raw) >= SIMILAR_THRESHOLD);
  if (dup) {
    const updated: MemEntry = { ...dup, text: raw, t: now, pinned: pinned || dup.pinned };
    saveMemory(dir, asker, entries.map((entry) => (entry.id === dup.id ? updated : entry)));
    return { ok: true, text: `已更新原有记忆条目：\n旧：${dup.text}\n新：${raw}` };
  }
  if (entries.some((entry) => entry.text === raw)) return { ok: true, text: `这条已经在记忆里了：${raw}` };
  if (entries.length >= MEMORY_MAX_ENTRIES) {
    return deny(`记忆已满（${MEMORY_MAX_ENTRIES} 条），请先删掉一些旧条目再用 forget。`);
  }
  const entry: MemEntry = {
    id: (input.id ?? newId)(),
    t: now,
    text: raw,
    ...(pinned ? { pinned: true } : {}),
  };
  saveMemory(dir, asker, [...entries, entry]);
  const how = input.pinned === true ? "设为核心" : autoPin ? "识别为身份类信息，已设为核心" : "已记住";
  return { ok: true, text: `已记住（第 ${entries.length + 1} 条，${how}）：${raw}` };
}
