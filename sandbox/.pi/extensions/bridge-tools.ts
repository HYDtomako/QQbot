/**
 * bridge-tools 扩展：与「咕嘎一号」（院长本机的 AI 助手，D:\pi-agent）通信。
 *
 * 机制（文件信箱，异步、互不阻塞）：
 *   - 本工具默认把留言追加到 memory/bridge/to-guga.jsonl；咕嘎一号的扩展在它每轮
 *     对话开始前读取该文件并把内容注入上下文（异步：得等它下一轮才处理）。
 *   - 若咕嘎一号的本地服务正在跑（默认 127.0.0.1:8787），本工具会直接 POST
 *     /api/send 把留言踢成一轮——此时不用等院长在页面上说话，接近即时执行。
 *     POST 不通（服务没起 / 超时）才回退到文件信箱，保证留言不丢。
 *   - 反过来，咕嘎一号写 memory/bridge/to-qq.jsonl，桥接（src/main.ts）每 3 秒轮询
 *     并通过 OneBot 真发到 QQ。
 *   - 回执：本工具会把「回发目标」（这条留言来自哪个群/私聊）随留言一起带给
 *     咕嘎一号；它处理完成后按该目标把结果回发到 QQ，院长就能在 QQ 里看到收尾。
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
const BRIDGE_DIR = path.join(ROOT_DIR, "memory", "bridge");
const TO_GUGA = path.join(BRIDGE_DIR, "to-guga.jsonl");
const MAX_TEXT_LEN = 4000;

// 咕嘎一号本地服务（pi-agent）：把留言直接踢成一轮，接近即时执行。
// 地址与端口要与 D:\pi-agent 的 config.json 里 gui.host / gui.port 一致。
const GUGA_ENDPOINT = "http://127.0.0.1:8787/api/send";
// 触发用什么模式："agent"=动手模式（能读写文件、跑命令），"chat"=问答模式（只查答）。
// QQ 带话多数是要干活的，所以默认动手；想更保守改成 "chat"。
const GUGA_TRIGGER_MODE: "agent" | "chat" = "agent";
const GUGA_PUSH_TIMEOUT_MS = 2500;

/** 尝试把留言推给咕嘎一号的本地服务；成功返回 true。失败静默，由调用方回退到文件。 */
async function pushToGuga(body: string, via: string): Promise<boolean> {
  try {
    const res = await fetch(GUGA_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `[来自 QQ bot（企鹅主任）的留言]\n${body}\n\n[回发目标] ${via}`,
        mode: GUGA_TRIGGER_MODE,
        uploads: [],
      }),
      signal: AbortSignal.timeout(GUGA_PUSH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const SCHEMA = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "要转达给咕嘎一号的完整内容。咕嘎一号看不到 QQ 群聊，请写清背景与要它做什么。",
    },
    asker_qq: { type: "string", description: "提问者 QQ 号（从消息来源标注如实取，用于权限校验）" },
    via: {
      type: "string",
      description:
        "这条留言来自哪个会话，咕嘎一号据此把处理结果回发过来。群聊填 group:<群号>，私聊填 private:<QQ号>。从消息来源标注如实取。",
    },
  },
  required: ["text", "asker_qq", "via"],
};

export default function bridgeToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "tell_guga",
    label: "Tell Guga",
    description: "把一条留言转达给院长本机的 AI 助手「咕嘎一号」（会直接推给它即时处理，服务不在线时落盘等它下次读）。",
    promptSnippet: "tell_guga: relay a message to the owner's local assistant 咕嘎一号",
    promptGuidelines: [
      "仅当院长本人（来源标注里标为「院长」的那个人）让你给「咕嘎一号」带话、转达、交代事情时调用；其他人一律拒绝。",
      "咕嘎一号是院长电脑上的本地助手，看不到 QQ 群聊；text 里要写清完整背景与院长要它做什么。",
      "这是即时转达：本工具会直接把留言推给咕嘎一号开始处理，院长不用再在它页面上另发消息。",
      "asker_qq 必须如实取消息开头来源标注里的 QQ 号。",
      "via 必须如实填这条留言来自哪个会话：群聊填 group:<群号>，私聊填 private:<QQ号>（从来源标注取）。咕嘎一号处理完会把结果回发到这里。",
    ],
    parameters: SCHEMA,
    async execute(_id, params) {
      const asker = String(params.asker_qq ?? "").trim();
      let owner = "";
      try {
        owner = String(JSON.parse(readFileSync(CONFIG_PATH, "utf8"))?.bot?.owner ?? "");
      } catch {
        return text("读取配置失败，暂时无法转达。");
      }
      if (!asker || asker !== owner) return text("只有院长可以让我给咕嘎一号带话。");

      const body = String(params.text ?? "").trim();
      if (!body) return text("要转达的内容为空。");
      if (body.length > MAX_TEXT_LEN) return text(`内容太长（${body.length} 字），请压缩到 ${MAX_TEXT_LEN} 字以内。`);

      // 回发目标：优先用传入的 via；缺失时兜底发给院长私聊，保证回执有去处。
      const via = String(params.via ?? "").trim() || (owner ? `private:${owner}` : "默认群");

      // 优先直接踢起咕嘎一号的一轮；服务不在线才落盘等它下次读。
      const pushed = await pushToGuga(body, via);
      if (!pushed) {
        mkdirSync(BRIDGE_DIR, { recursive: true });
        appendFileSync(
          TO_GUGA,
          JSON.stringify({ t: new Date().toISOString(), from: asker, via, text: body }) + "\n",
        );
      }
      return text(
        pushed
          ? `已转达给咕嘎一号，正在处理（${body.length} 字）。它处理完会把结果回发到本会话。`
          : `已转达给咕嘎一号（${body.length} 字，它下次运行时处理）。它处理完会把结果回发到本会话。`,
      );
    },
  });
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}
