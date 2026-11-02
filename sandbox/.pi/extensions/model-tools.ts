/**
 * model-tools：把查询/切换模型交给桥接。
 *
 * 身份与 voice_send / tell_guga / mode_manage 同一条回环通道
 * （QQ_MODEL_ENDPOINT / QQ_MODEL_TOKEN，与 QQ_VOICE_TOKEN 同一枚）。
 * 本工具只提交 op，以及 switch 时的 alias。提问者 QQ 由桥接按本轮 OneBot 事件填写。
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

const SCHEMA = {
  type: "object",
  properties: {
    op: { type: "string", description: "操作：status（查当前模型）/ switch（切换）/ list（列出可用模型）" },
    alias: { type: "string", description: "switch 时切到哪个模型（可用别名或模型名，如 deepseek-flash、glm、glm-5.3）" },
  },
  required: ["op"],
};

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

export default function modelToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "model_manage",
    label: "Model Manage",
    description: "查询或切换当前使用的 AI 模型（仅院长可用）。身份由桥接按本轮 QQ 会话判定。",
    promptSnippet: "model_manage: check or switch the active model",
    promptGuidelines: [
      "仅当来源标注为「院长」的人要求查询或切换模型时才调用；其他人礼貌拒绝，也不透露任何模型信息，不要调用。",
      "只填写 op，switch 时再填 alias。不要填写提问者 QQ；桥接按这一轮会话判断是谁，填了也无效。",
      "问现在用的什么模型 → op=status；换成某个模型 → op=switch，alias 只填模型名；问有哪些模型 → op=list。",
      "不确定他指哪个模型时，先 list 出来让他挑。",
      "工具返回什么就如实转告。返回失败时不要声称已经切换，也不要自行补充模型名称。",
    ],
    parameters: SCHEMA,
    async execute(_id, params) {
      const endpoint = process.env.QQ_MODEL_ENDPOINT ?? "";
      const token = process.env.QQ_MODEL_TOKEN ?? "";
      if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/model-manage$/.test(endpoint) || !/^[a-f0-9]{64}$/.test(token)) {
        return text("本次会话没有模型管理权限。");
      }
      const op = String(params.op ?? "").trim();
      const alias = String(params.alias ?? "").trim();
      const payload: Record<string, string> = { op };
      if (alias) payload.alias = alias;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        });
        const value = await response.json() as { text?: string };
        if (typeof value.text !== "string") return text("模型服务返回异常，没有切换。");
        return text(value.text);
      } catch {
        return text("模型服务不可用，没有切换。");
      }
    },
  });
}
