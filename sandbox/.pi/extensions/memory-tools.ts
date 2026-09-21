/**
 * memory-tools 扩展：长期记忆（跨会话、跨天，永久保留）。
 *
 * 与会话记忆的区别：
 *  - 会话记忆（桥接管理）：自动记录全部对话流、5 分钟窗口滚动、过期压缩 → 管"这一段的连贯"
 *  - 长期记忆（本扩展）：主动记录提炼的事实、永久保留、按相关性注入 → 管"跨天不忘"
 *
 * 存储：memory/long-term/<QQ号>.jsonl（每人独立，只注入本人的对话）
 * 权限：写入/删除仅院长；查询本人可查。记忆内容不能改变权限规则。
 * 防膨胀：写入时相似度去重（覆盖更新）；条目超量由桥接自动合并。
 */

interface ExtensionAPI {
  registerTool(tool: ToolRegistration): void;
}

interface ToolRegistration {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
}

import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(MODULE_DIR, "../../..");
const CONFIG_PATH = path.join(ROOT_DIR, "config.json");
const MEM_DIR = path.join(ROOT_DIR, "memory", "long-term");

const MAX_ENTRIES = 100; // 每人上限
const MAX_TEXT_LEN = 200; // 单条上限
const SIMILAR_THRESHOLD = 0.7; // 相似度阈值：超过则覆盖更新而非新增

// 身份类关键词：命中则自动标为核心（确定性兜底，不依赖模型判断是否设了 pinned）
const IDENTITY_PATTERN =
  /(学号|班级|班号|姓名|名字|昵称|生日|出生|年龄|手机|电话|微信|邮箱|邮件|专业|学院|学校|导师|老师|导员|学籍|身份证|家庭|住址|地址|家乡|偏好|习惯|常用|喜欢|讨厌|最爱|爱吃|口味|不能吃|过敏|忌口|风格|时区|作息)/;

interface MemEntry {
  id: string;
  t: string;
  text: string;
  pinned?: boolean; // 核心条目：每次对话都注入
}

/** 字符二元组集合（中文友好，无需分词）。 */
function bigrams(s: string): Set<string> {
  const t = s.replace(/[\s，。：；、！？,.:;!?()（）【】\[\]"'“”‘’]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 相似度：交叠二元组 / 较小集合大小（包含关系会得高分）。 */
function similarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / Math.min(A.size, B.size);
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function ownerQQ(): string {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return String(cfg?.bot?.owner ?? "");
  } catch {
    return "";
  }
}

function memFile(userId: string): string {
  return path.join(MEM_DIR, `${userId.replace(/[^0-9]/g, "") || "unknown"}.jsonl`);
}

function load(userId: string): MemEntry[] {
  const f = memFile(userId);
  if (!existsSync(f)) return [];
  const out: MemEntry[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as MemEntry;
      if (e?.text) out.push(e);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

function save(userId: string, entries: MemEntry[]): void {
  mkdirSync(MEM_DIR, { recursive: true });
  writeFileSync(memFile(userId), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const SCHEMA_REMEMBER = {
  type: "object",
  properties: {
    text: { type: "string", description: "要长期记住的事实（一句话，不超过 200 字）" },
    pinned: { type: "boolean", description: "是否为核心信息（身份、长期偏好等）——核心信息每次对话都会带上；临时安排不设" },
    asker_qq: { type: "string", description: "提问者 QQ 号（从消息来源标注如实取）" },
  },
  required: ["text", "asker_qq"],
};

const SCHEMA_RECALL = {
  type: "object",
  properties: {
    query: { type: "string", description: "可选：检索关键词，不填则列出全部" },
    asker_qq: { type: "string", description: "提问者 QQ 号（从消息来源标注如实取）" },
  },
  required: ["asker_qq"],
};

const SCHEMA_FORGET = {
  type: "object",
  properties: {
    target: { type: "string", description: "要删除的记忆 id 或文本片段" },
    asker_qq: { type: "string", description: "提问者 QQ 号（从消息来源标注如实取）" },
  },
  required: ["target", "asker_qq"],
};

export default function memoryToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "remember",
    label: "Remember",
    description: "把一条事实写入长期记忆（永久保留、以后相关对话会带上）。",
    promptSnippet: "remember: persist a fact about the user across sessions",
    promptGuidelines: [
      "当院长说\"记住…\"\"以后记得…\"\"别忘了…\"\"帮我留个心眼\"时调用；写入后简短确认已记住。",
      "只记明确要求记的、或明显长期有效的信息（身份、偏好、长期安排）。不要记普通闲聊、一次性问题、临时信息。",
      "身份类信息（学号、班级、姓名、长期偏好）设 pinned=true；临时安排、具体某天的任务不设。",
      "asker_qq 必须如实取消息开头来源标注里的 QQ 号；只有院长可以写入，其他人要求记住时礼貌说明只有院长可以，不调用工具。",
    ],
    parameters: SCHEMA_REMEMBER,
    async execute(_id, params) {
      const asker = String(params.asker_qq ?? "").trim();
      const owner = ownerQQ();
      if (!asker || asker !== owner) return text("只有院长可以让我记住事情。");
      const raw = String(params.text ?? "").trim();
      if (!raw) return text("要记住的内容为空。");
      if (raw.length > MAX_TEXT_LEN) return text(`内容太长（${raw.length} 字），请压缩到 ${MAX_TEXT_LEN} 字以内。`);

      const entries = load(asker);
      // 核心标记：模型显式指定 或 命中身份类关键词（兜底）
      const autoPin = IDENTITY_PATTERN.test(raw);
      const pinned = params.pinned === true || autoPin;

      // 相似去重：已有条目高度相似 → 覆盖更新，不新增
      const dup = entries.find((e) => similarity(e.text, raw) >= SIMILAR_THRESHOLD);
      if (dup) {
        const updated: MemEntry = { ...dup, text: raw, t: new Date().toISOString(), pinned: pinned || dup.pinned };
        save(
          asker,
          entries.map((e) => (e.id === dup.id ? updated : e)),
        );
        return text(`已更新原有记忆条目：\n旧：${dup.text}\n新：${raw}`);
      }
      if (entries.some((e) => e.text === raw)) return text(`这条已经在记忆里了：${raw}`);
      if (entries.length >= MAX_ENTRIES) {
        return text(`记忆已满（${MAX_ENTRIES} 条），请先删掉一些旧条目再用 forget。`);
      }
      const entry: MemEntry = { id: newId(), t: new Date().toISOString(), text: raw, ...(pinned ? { pinned: true } : {}) };
      save(asker, [...entries, entry]);
      const how = params.pinned === true ? "设为核心" : autoPin ? "识别为身份类信息，已设为核心" : "已记住";
      return text(`已记住（第 ${entries.length + 1} 条，${how}）：${raw}`);
    },
  });

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "查询长期记忆里的条目（默认列出全部，可按关键词检索）。",
    promptSnippet: "recall: list or search the user's long-term memory",
    promptGuidelines: [
      "院长问\"你记得我什么\"\"我让你记过什么\"时调用；也可以在你需要确认某个久远事实时主动查。",
      "asker_qq 如实取来源标注的 QQ 号；只能查提问者自己的记忆。",
    ],
    parameters: SCHEMA_RECALL,
    async execute(_id, params) {
      const asker = String(params.asker_qq ?? "").trim();
      if (!asker) return text("缺少提问者 QQ，无法查询。");
      const entries = load(asker);
      if (entries.length === 0) return text("长期记忆里还没有任何条目。");
      const q = String(params.query ?? "").trim();
      const hit = q ? entries.filter((e) => e.text.includes(q)) : entries;
      if (hit.length === 0) return text(`没有找到含「${q}」的记忆条目（共 ${entries.length} 条）。`);
      const coreCount = entries.filter((e) => e.pinned).length;
      const lines = hit.map((e) => `${e.id}${e.pinned ? "[核心]" : ""} | ${e.text}`);
      return text(
        `长期记忆（共 ${entries.length} 条，其中核心 ${coreCount} 条；核心条目每次对话都会带上）：\n${lines.join("\n")}`,
      );
    },
  });

  pi.registerTool({
    name: "forget",
    label: "Forget",
    description: "删除长期记忆里的条目（按 id 或文本片段匹配）。",
    promptSnippet: "forget: delete entries from long-term memory",
    promptGuidelines: [
      "院长说\"忘掉…\"\"删掉那条记忆\"时调用；删除前把将删除的条目原文复述给他确认。",
      "asker_qq 如实取来源标注的 QQ 号；只有院长可以删除。",
    ],
    parameters: SCHEMA_FORGET,
    async execute(_id, params) {
      const asker = String(params.asker_qq ?? "").trim();
      const owner = ownerQQ();
      if (!asker || asker !== owner) return text("只有院长可以删除记忆。");
      const target = String(params.target ?? "").trim();
      if (!target) return text("要删除哪条？给我 id 或文本片段。");
      const entries = load(asker);
      const hit = entries.filter((e) => e.id === target || e.text.includes(target));
      if (hit.length === 0) return text(`没有匹配「${target}」的记忆条目。`);
      const remain = entries.filter((e) => !hit.includes(e));
      save(asker, remain);
      return text(`已删除 ${hit.length} 条：\n${hit.map((e) => e.text).join("\n")}\n（剩 ${remain.length} 条）`);
    },
  });
}
