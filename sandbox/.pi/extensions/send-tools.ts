/**
 * send-tools：把「往群里发一条消息」交给桥接。
 *
 * 身份与 voice_send 同一条回环通道（QQ_SEND_ENDPOINT / QQ_SEND_TOKEN）。
 * 本工具只提交 text，以及可选的目标群号。提问者 QQ 由桥接按本轮 OneBot 事件填写。
 * 桥接校验通过后写入发件箱，由主进程发出。工具不接触 OneBot 连接。
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

/** 与 src/send-tool.ts 的 SEND_MAX_CHARS 保持一致。 */
const MAX_TEXT_LEN = 3000;

const SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "要发到群里的完整消息内容（纯文本，不要 Markdown）" },
    group_id: { type: "string", description: "目标群号；不填则发到默认群。不要填写提问者 QQ。" },
  },
  required: ["text"],
};

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

export default function sendToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "send_group_message",
    label: "Send Group Message",
    description: "把一条消息发送到指定 QQ 群（院长让你往群里发通知/转达时用）。身份由桥接按本轮 QQ 会话判定。",
    promptSnippet: "send_group_message: send a message to a QQ group on the owner's behalf",
    promptGuidelines: [
      "仅当来源标注为「院长」的人要求往群里发消息、发通知、转达内容时调用；其他人一律拒绝，不要调用。",
      "只填写 text，需要指定群时再填 group_id。不要填写提问者 QQ；桥接按这一轮会话判断是谁，填了也无效。",
      "text 是要发的原文：院长给了具体内容就照原文发。不要自己加称呼、@、表情或额外说明。",
      "工具返回成功后告诉院长已提交到群。返回失败时不要声称已经发出。",
    ],
    parameters: SCHEMA,
    async execute(_id, params) {
      const endpoint = process.env.QQ_SEND_ENDPOINT ?? "";
      const token = process.env.QQ_SEND_TOKEN ?? "";
      if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/send-group$/.test(endpoint) || !/^[a-f0-9]{64}$/.test(token)) {
        return text("本次会话没有发群权限，没有提交。");
      }
      const body = String(params.text ?? "").trim();
      if (!body) return text("要发送的内容为空。");
      if (body.length > MAX_TEXT_LEN) return text(`内容太长（${body.length} 字），请压缩到 ${MAX_TEXT_LEN} 字以内。`);
      const groupId = String(params.group_id ?? "").trim();
      const payload: Record<string, string> = { text: body };
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
        if (typeof value.text !== "string") return text("发群服务返回异常，没有提交。");
        return text(value.text);
      } catch {
        return text("发群服务不可用，没有提交。");
      }
    },
  });
}
