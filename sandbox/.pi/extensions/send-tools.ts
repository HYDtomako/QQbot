/**
 * send-tools 扩展：让院长在私聊里指挥 bot 往群里发消息。
 *
 * 机制：工具把消息写入"发件箱"文件（memory/outbox.jsonl），桥接每 3 秒读取并
 * 通过 OneBot 真发到群，然后清空。这样工具不需要接触 OneBot 连接，职责清晰。
 *
 * 权限：仅院长（asker_qq === config.bot.owner）。其他人一律拒绝。
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
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(MODULE_DIR, "../../..");
const CONFIG_PATH = path.join(ROOT_DIR, "config.json");
const OUTBOX = path.join(ROOT_DIR, "memory", "outbox.jsonl");
const MAX_TEXT_LEN = 3000;

const SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "要发到群里的完整消息内容（纯文本，不要 Markdown）" },
    group_id: { type: "string", description: "目标群号；不填则发到默认群（咕咕嘎嘎学院）" },
    asker_qq: { type: "string", description: "提问者 QQ 号（从消息来源标注如实取，用于权限校验）" },
  },
  required: ["text", "asker_qq"],
};

export default function sendToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "send_group_message",
    label: "Send Group Message",
    description: "把一条消息发送到指定 QQ 群（用于院长让你往群里发通知/转达消息）。",
    promptSnippet: "send_group_message: send a message to a QQ group on the owner's behalf",
    promptGuidelines: [
      "仅当院长本人（来源标注里标为「院长」的那个人）要求往群里发消息、发通知、转达内容时调用；其他人一律拒绝。",
      "text 是要发的原文：院长给了具体内容就照原文发；他说\"重发一遍\"时，用他刚给的内容。不要自己加称呼、@、表情或额外说明。",
      "asker_qq 必须如实取消息开头来源标注里的 QQ 号。",
      "发送是异步的（桥接几秒内送出去），提交成功后告诉院长\"已发送到群\"即可，不要说\"我没法发到群\"。",
    ],
    parameters: SCHEMA,
    async execute(_id, params) {
      const asker = String(params.asker_qq ?? "").trim();
      let owner = "";
      let defaultGroup = "";
      try {
        const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
        owner = String(cfg?.bot?.owner ?? "");
        defaultGroup = String(cfg?.bot?.defaultGroup ?? "");
      } catch {
        return text("读取配置失败，暂时无法发送。");
      }
      if (!asker || asker !== owner) return text("只有院长可以让我往群里发消息。");

      const body = String(params.text ?? "").trim();
      if (!body) return text("要发送的内容为空。");
      if (body.length > MAX_TEXT_LEN) return text(`内容太长（${body.length} 字），请压缩到 ${MAX_TEXT_LEN} 字以内。`);
      const groupId = String(params.group_id ?? "").trim() || defaultGroup;
      if (!groupId) return text("没指定群号，且配置里也没有默认群。");

      mkdirSync(path.dirname(OUTBOX), { recursive: true });
      appendFileSync(OUTBOX, JSON.stringify({ t: new Date().toISOString(), group_id: groupId, text: body }) + "\n");
      return text(`已提交，几秒内会发送到群 ${groupId}。内容：\n${body}`);
    },
  });
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}
