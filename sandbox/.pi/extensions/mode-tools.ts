/**
 * mode-tools：把娱乐模式开关交给桥接。
 *
 * 身份与 voice_send / tell_guga 同一条回环通道（QQ_MODE_ENDPOINT / QQ_MODE_TOKEN）。
 * 本工具只提交 op，以及私聊时可选的 group_id。提问者 QQ 由桥接按本轮 OneBot 事件填写。
 * 群聊里要操作的群也以这轮会话为准，工具不负责改写。
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
    op: { type: "string", description: "操作：status（查看已开启的群）/ on（开启）/ off（关闭）" },
    group_id: {
      type: "string",
      description: "仅私聊使用：要操作的群号。不填则用默认群。群聊里不要填，桥接使用当前群。",
    },
  },
  required: ["op"],
};

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

export default function modeToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "mode_manage",
    label: "Mode Manage",
    description: "查询、开启或关闭某个 QQ 群的娱乐模式。只有院长可以操作；身份由桥接按本轮 QQ 会话判定。",
    promptSnippet: "mode_manage: check/enable/disable entertainment mode for a QQ group",
    promptGuidelines: [
      "仅当来源标注为「院长」的人要求查询、开启或关闭娱乐模式时才调用；其他人礼貌拒绝，不要调用。",
      "只填写 op。不要填写提问者 QQ；桥接按这一轮会话判断是谁，模型填了也无效。",
      "群聊里不要填 group_id，目标群就是当前会话。私聊里院长指定了群就填 group_id，没指定就省略，桥接用默认群。",
      "问哪些群开了娱乐模式 → op=status；说开启/打开 → op=on；说关闭/退出 → op=off。",
      "工具返回什么就如实转告，不要自行补充没有发生的结果。",
    ],
    parameters: SCHEMA,
    async execute(_id, params) {
      const endpoint = process.env.QQ_MODE_ENDPOINT ?? "";
      const token = process.env.QQ_MODE_TOKEN ?? "";
      if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/mode-manage$/.test(endpoint) || !/^[a-f0-9]{64}$/.test(token)) {
        return text("本次会话没有模式管理权限。");
      }
      const op = String(params.op ?? "").trim();
      const groupId = String(params.group_id ?? "").trim();
      const payload: Record<string, string> = { op };
      if (groupId) payload.group_id = groupId;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        });
        const value = await response.json() as { text?: string };
        if (typeof value.text !== "string") return text("模式服务返回异常，没有切换。");
        return text(value.text);
      } catch {
        return text("模式服务不可用，没有切换。");
      }
    },
  });
}
