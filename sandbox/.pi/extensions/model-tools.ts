/**
 * model-tools 扩展：让院长用任意自然语言查询/切换模型。
 *
 * 双通道设计：桥接层保留常见说法的正则快路径（秒回、零 token）；
 * 其余说法由 pi 理解后调用本工具——两条路写的是同一个状态文件（.model-state.json），
 * 桥接监视该文件，切换后十几秒内全局生效。
 *
 * 权限：仅院长（asker_qq === config.bot.owner）。其他人一律拒绝，也不透露模型信息。
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(MODULE_DIR, "../../..");
const CONFIG_PATH = path.join(ROOT_DIR, "config.json");
const STATE_PATH = path.join(ROOT_DIR, ".model-state.json");

const SCHEMA = {
  type: "object",
  properties: {
    op: { type: "string", description: "操作：status（查当前模型）/ switch（切换）/ list（列出可用模型）" },
    alias: { type: "string", description: "switch 时切到哪个模型（可用别名或模型名，如 deepseek-flash、glm、glm-5.3）" },
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

export default function modelToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "model_manage",
    label: "Model Manage",
    description: "查询或切换当前使用的 AI 模型（仅院长可用）。",
    promptSnippet: "model_manage: check or switch the active model",
    promptGuidelines: [
      "仅当院长本人（来源标注里标为「院长」的那个人）要求查询/切换模型时才调用；其他人要求时礼貌拒绝，也不透露任何模型信息。",
      "把院长的自然语言转成 op：问\"现在用的什么模型/哪个模型\"→ status；\"换成X/切到X/用X\"→ switch + alias；\"有哪些模型可选\"→ list。",
      "alias 只填模型名，别把整句话塞进去；不确定他指哪个模型时，先 list 出来让他挑。",
      "asker_qq 必须如实取消息开头来源标注里的 QQ 号。",
      "切换是全局生效（私聊、群聊、定时任务都会用新模型），十几秒内生效——告诉院长\"已切到 X\"即可。",
    ],
    parameters: SCHEMA,
    async execute(_id, params) {
      const cfg = readJson<{ bot?: { owner?: string }; pi?: { models?: Record<string, string>; defaultModel?: string } }>(
        CONFIG_PATH,
      );
      const owner = String(cfg?.bot?.owner ?? "");
      const asker = String(params.asker_qq ?? "").trim();
      if (!asker || asker !== owner) return text("只有院长可以查询或切换模型。");

      const models = cfg?.pi?.models ?? {};
      const aliases = Object.keys(models);
      const state = readJson<{ alias?: string }>(STATE_PATH);
      const current = state?.alias && models[state.alias] ? state.alias : String(cfg?.pi?.defaultModel ?? aliases[0] ?? "");

      const op = String(params.op ?? "").trim();
      switch (op) {
        case "status":
          return text(`当前模型：${current}（${models[current] ?? "?"}）`);
        case "list":
          return text(`可用模型：${aliases.map((a) => `${a}（${models[a]}）`).join("、")}。切换说法：\"切换模型 xxx\" 或直接跟我说\"换成 xxx\"。`);
        case "switch": {
          const raw = String(params.alias ?? "").trim().toLowerCase();
          if (!raw) return text("要切到哪个模型？可用：" + aliases.join("、"));
          let alias = aliases.find((a) => a === raw) ?? "";
          if (!alias) alias = aliases.find((a) => models[a] === raw || models[a].endsWith("/" + raw)) ?? "";
          if (!alias) alias = aliases.find((a) => a.startsWith(raw) || raw.startsWith(a) || models[a].toLowerCase().includes(raw)) ?? "";
          if (!alias) return text(`没有「${raw}」这个模型。可用：${aliases.join("、")}`);
          if (alias === current) return text(`当前已经在用 ${alias} 了。`);
          writeFileSync(STATE_PATH, JSON.stringify({ alias }, null, 2));
          return text(`已切到 ${alias}（${models[alias]}）。全局生效，十几秒后所有对话都用它。`);
        }
        default:
          return text("未知操作，应为 status / switch / list。");
      }
    },
  });
}
