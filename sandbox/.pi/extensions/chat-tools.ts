/**
 * chat-tools 扩展：群聊记录总结。
 * 数据来源：桥接落盘的按天聊天日志 memory/group-chat/<群号>-<日期>.jsonl。
 * pi 调 chat_digest 拿到当天消息流后，自行做自然语言总结（话题/活跃成员/事件）。
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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(MODULE_DIR, "../../..");
const LOG_DIR = path.join(ROOT_DIR, "memory", "group-chat");

const SCHEMA = {
  type: "object",
  properties: {
    date: { type: "string", description: "要总结的日期，格式 YYYY-MM-DD；不填表示今天" },
    group_id: { type: "string", description: "群号；当前只维护一个群时可不填" },
  },
  required: [],
};

const MAX_CHARS = 16_000;

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function chatToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "chat_digest",
    label: "Chat Digest",
    description: "获取某天的群聊记录（时间/发言人/内容），用于总结当天群聊的话题与活跃情况。",
    promptSnippet: "chat_digest: fetch the day's group chat log for summarization",
    promptGuidelines: [
      "用户问\"今天群里聊了什么\"\"总结一下聊天\"时调用本工具，然后输出话题总结、活跃成员、值得注意的事件。",
      "记录可能被截断，总结时如实说明范围；不要编造没出现过的内容。",
    ],
    parameters: SCHEMA,
    async execute(_id, params) {
      const now = new Date();
      const ymd = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      let dateStr = String(params.date ?? "").trim() || ymd(now);
      if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(dateStr)) {
        const [y, m, d] = dateStr.split("-").map(Number);
        dateStr = ymd(new Date(y, m - 1, d));
      } else {
        return text("日期格式请用 YYYY-MM-DD。");
      }

      const gid = String(params.group_id ?? "").trim();
      const files = existsSync(LOG_DIR)
        ? readdirSync(LOG_DIR).filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(/\.jsonl$/, ""))
        : [];
      const target = gid || (files.length === 1 ? files[0].split("-").slice(0, -3).join("-") : "");
      if (!target) return text(`存在多个群的记录（${files.join("、")}），请指定群号。`);

      const file = path.join(LOG_DIR, `${target}-${dateStr}.jsonl`);
      if (!existsSync(file)) return text(`${dateStr} 群 ${target} 没有聊天记录。`);

      const lines = readFileSync(file, "utf8").split("\n").filter((x) => x.trim());
      const entries = lines
        .map((l) => {
          try {
            return JSON.parse(l) as { t: string; u: string; n: string; m: string };
          } catch {
            return null;
          }
        })
        .filter(Boolean) as Array<{ t: string; u: string; n: string; m: string }>;
      if (entries.length === 0) return text(`${dateStr} 没有可读的聊天记录。`);

      const users = new Map<string, number>();
      for (const e of entries) users.set(e.n, (users.get(e.n) ?? 0) + 1);
      const top = [...users.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

      let body = "";
      let shown = 0;
      for (const e of entries) {
        const line = `[${hhmm(e.t)}] ${e.n}: ${e.m}`;
        if (body.length + line.length > MAX_CHARS) {
          body += `\n（记录过长，仅显示最近 ${shown} 条，全部共 ${entries.length} 条）`;
          break;
        }
        body += line + "\n";
        shown++;
      }
      // 截断时优先展示最近的：改取尾部
      if (shown < entries.length) {
        const tail: string[] = [];
        let len = 0;
        for (let i = entries.length - 1; i >= 0 && len <= MAX_CHARS; i--) {
          const line = `[${hhmm(entries[i].t)}] ${entries[i].n}: ${entries[i].m}`;
          len += line.length;
          tail.unshift(line);
        }
        body = `（共 ${entries.length} 条，显示最近的 ${tail.length} 条）\n` + tail.join("\n");
      }

      return text(
        `${dateStr} 群 ${target} 聊天记录：共 ${entries.length} 条消息，${users.size} 人参与。最活跃：${top
          .map(([n, c]) => `${n}(${c}条)`)
          .join("、")}\n\n${body}`,
      );
    },
  });
}
