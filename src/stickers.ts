/**
 * 娱乐模式表情包：本地素材目录 + 清单文件。
 *
 * 图片放 stickers/，清单写 stickers/manifest.json：
 *   { "version": 1, "stickers": [ { "id": "", "file": "", "name": "", "description": "" } ] }
 * 仅娱乐模式使用。模型只看到 id、名称和场景描述，按聊天意图挑 ID；
 * 桥接校验后发送原文件字节（文件缺失/坏清单/发送被拒时安全回退纯文字）。
 */

import path from "node:path";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { MessageSegment } from "./onebot.ts";

export interface StickerEntry {
  /** 小写英文、数字、下划线或连字符，模型用它来选择 */
  id: string;
  /** 素材目录内的文件名 */
  file: string;
  /** 给模型看的中文名 */
  name: string;
  /** 使用场景描述（选图依据） */
  description: string;
  /** 解析后的绝对路径 */
  path: string;
}

export interface EntertainmentReply {
  valid: boolean;
  text: string;
  sticker: string | null;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 单文件不超过 8 MiB
const EXT_RE = /\.(?:png|jpe?g|gif)$/i;
const ID_RE = /^[a-z0-9_-]+$/;
const SEND_COOLDOWN_MS = 60_000; // 刚发过图：60 秒内不再发图（避免连发图片）
const REPEAT_COOLDOWN_MS = 600_000; // 同一个 ID：10 分钟内不重复

interface GroupState {
  lastSentAt: number;
  sentIds: Map<string, number>;
}

export class StickerLibrary {
  private readonly dir: string;
  private readonly states = new Map<string, GroupState>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** 本轮可用的表情包（按群过滤冷却）。 */
  available(gid: string, now: number = Date.now()): StickerEntry[] {
    const st = this.state(gid, now);
    if (now - st.lastSentAt < SEND_COOLDOWN_MS) return [];
    return this.load().filter((e) => now - (st.sentIds.get(e.id) ?? 0) >= REPEAT_COOLDOWN_MS);
  }

  /**
   * 读取选中的素材，生成图片消息段（base64 发送原文件字节，GIF 不做转码）。
   * 文件被删/被换会抛错，由调用方回退纯文字。
   */
  image(entry: StickerEntry): MessageSegment {
    const buf = readFileSync(entry.path);
    if (buf.length === 0 || buf.length > MAX_FILE_BYTES) throw new Error(`表情包文件异常: ${entry.id}`);
    return { type: "image", data: { file: "base64://" + buf.toString("base64") } };
  }

  /** 表情包真正发出后记账（stickerId 为 null 表示本轮没发图）。 */
  recordSent(gid: string, stickerId: string | null, ts: number): void {
    const st = this.state(gid, ts);
    if (!stickerId) return;
    st.lastSentAt = ts;
    st.sentIds.set(stickerId, ts);
  }

  private state(gid: string, now: number): GroupState {
    let st = this.states.get(gid);
    if (!st) {
      st = { lastSentAt: 0, sentIds: new Map() };
      this.states.set(gid, st);
    }
    for (const [id, ts] of st.sentIds) if (now - ts >= REPEAT_COOLDOWN_MS) st.sentIds.delete(id);
    return st;
  }

  /**
   * 读取并校验清单：每次调用都重新读（改清单、换素材无需重启）。
   * 任何异常（目录缺失、坏 JSON、条目不合法）都按“没有表情包”处理，不让调用方兜底。
   */
  private load(): StickerEntry[] {
    try {
      const manifestPath = path.join(this.dir, "manifest.json");
      if (!existsSync(manifestPath)) return [];
      const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown; stickers?: unknown };
      if (raw?.version !== 1 || !Array.isArray(raw.stickers)) return [];
      const dirReal = realpathSync(this.dir);
      const out: StickerEntry[] = [];
      const seen = new Set<string>();
      for (const item of raw.stickers) {
        try {
          const entry = this.validate(item as Record<string, unknown>, dirReal, seen);
          if (entry) out.push(entry);
        } catch {
          /* 单条不合法只跳过这一条 */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private validate(item: Record<string, unknown>, dirReal: string, seen: Set<string>): StickerEntry | null {
    const id = String(item?.id ?? "").trim();
    const file = String(item?.file ?? "").trim();
    if (!ID_RE.test(id) || seen.has(id) || !file || !EXT_RE.test(file)) return null;
    // 文件必须在素材目录内（用 realpath 判定，符号链接指向外面也不行）
    const fileReal = realpathSync(path.resolve(this.dir, file));
    const rel = path.relative(dirReal, fileReal);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const st = statSync(fileReal);
    if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES) return null;
    seen.add(id);
    return {
      id,
      file,
      name: String(item?.name ?? "").trim() || id,
      description: String(item?.description ?? "").trim(),
      path: fileReal,
    };
  }
}

/**
 * 解析娱乐模式的回复协议：
 *   - 合法 JSON {"text":"…","sticker":"id"|null} → 用协议字段（sticker 是否在候选里由调用方校验）
 *   - 纯文本按老格式兜底（模型没按协议输出时照常发）；“这次不说了” = 沉默
 *   - 看起来是 JSON（含 {）但解析不了 → 整条作废：宁可不发，也不把半截 JSON 发进群
 */
export function parseEntertainmentReply(raw: string): EntertainmentReply {
  const t = String(raw ?? "").trim();
  if (!t || /^这次不说了[。.!！]?$/.test(t)) return { valid: true, text: "", sticker: null };
  if (t.includes("{")) {
    const cleaned = t.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
    let obj: unknown;
    try {
      obj = JSON.parse(cleaned);
    } catch {
      return { valid: false, text: "", sticker: null };
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { valid: false, text: "", sticker: null };
    const rec = obj as { text?: unknown; sticker?: unknown };
    const text = typeof rec.text === "string" ? rec.text : "";
    const sk = typeof rec.sticker === "string" ? rec.sticker.trim() : "";
    return { valid: true, text, sticker: sk && sk !== "null" ? sk : null };
  }
  return { valid: true, text: t, sticker: null };
}

/** 拼给模型的回复协议说明与本轮可选表情包清单。 */
export function stickerPrompt(choices: StickerEntry[]): string {
  const list = choices.length
    ? `本轮可选表情包：\n${choices.map((s) => `- ${s.id}（${s.name}）${s.description ? `：${s.description}` : ""}`).join("\n")}\n`
    : `本轮没有可用表情包。\n`;
  const pick = choices.length ? "sticker 只能为上述 ID 或 null" : "sticker 只能为 null";
  return (
    `\n[回复协议] 本轮只返回一个 JSON 对象：{"text":"要说的话","sticker":null}，不要代码围栏或解释。` +
    `text 是自然、简短的纯文本；${pick}，不能写路径或 URL；只发图时 text 置空；` +
    `图已经把意思表达完整就不要再用文字重复解释，没有贴切的图就不用，别按关键词机械选图；` +
    `决定沉默时返回 {"text":"","sticker":null}。\n${list}`
  );
}
