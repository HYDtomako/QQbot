/**
 * mode-tools 扩展：让院长用自然语言管理娱乐模式。
 *
 * 工具读写 modes.json；桥接监视该文件变化后热更新内存状态，无需重启。
 * 权限：仅院长（asker_qq === config.bot.owner）。
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
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(MODULE_DIR, "../../..");
const CONFIG_PATH = path.join(ROOT_DIR, "config.json");

const SCHEMA = {
  type: "object",
  properties: {
    op: { type: "string", description: "操作：status（查看已开启的群）/ on（开启）/ off（关闭）" },
    group_id: { type: "string", description: "目标群号；群聊填当前群号，私聊不填则用默认群" },
    asker_qq: { type: "string", description: "提问者 QQ 号（从消息来源标注如实取，用于权限校验）" },
  },
  required: ["op", "asker_qq"],
};

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function readJson<T>(p: string): T | null {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

export default function modeToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "mode_manage",
    label: "Mode Manage",
    description: "查询、开启或关闭某个 QQ 群的娱乐模式（仅院长可用）。",
    promptSnippet: "mode_manage: check/enable/disable entertainment mode for a QQ group",
    promptGuidelines: [
      "仅当院长本人（来源标注里标为「院长」的那个人）要求查询、开启或关闭娱乐模式时才调用；其他人要求时礼貌拒绝。",
      "群聊里操作当前群：group_id 填消息来源标注里的群号。私聊里院长没指定群时，group_id 可省略，使用默认群。",
      "院长问哪些群开了娱乐模式 → op=status；说开启/打开 → op=on；说关闭/退出 → op=off。",
      "asker_qq 必须如实取消息开头来源标注里的 QQ 号。",
      "工具返回什么就如实转告院长，不要自行补充没有发生的结果。",
    ],
    parameters: SCHEMA,
    async execute(_id, params) {
      const cfg = readJson<{ bot?: { owner?: string } }>(CONFIG_PATH);
      const owner = String(cfg?.bot?.owner ?? "");
      const asker = String(params.asker_qq ?? "").trim();
      if (!asker || asker !== owner) return text("只有院长可以管理娱乐模式。");

      const op = String(params.op ?? "").trim();
      if (op !== "status" && op !== "on" && op !== "off") return text("未知操作，应为 status / on / off。");
      const endpoint = process.env.QQ_MODE_CMD_ENDPOINT ?? "";
      const token = process.env.QQ_MODE_CMD_TOKEN ?? "";
      if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/mode-command$/.test(endpoint) || !/^[a-f0-9]{64}$/.test(token)) {
        return text("本次运行未获得模式管理权限，操作未执行。");
      }
      const groupId = String(params.group_id ?? "").trim();
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ op, ...(groupId ? { group_id: groupId } : {}) }),
          signal: AbortSignal.timeout(12000),
          redirect: "error",
        });
        const value = await response.json() as { ok?: boolean; text?: string };
        if (typeof value.text !== "string") return text("模式服务返回格式异常，操作未确认成功。");
        return text(value.text);
      } catch {
        return text("模式服务不可用或凭据已失效，操作未确认成功；不要声称已经切换。");
      }
    },
  });
}
