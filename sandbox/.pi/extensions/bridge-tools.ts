/**
 * bridge-tools：把一条留言交给桥接，由桥接转给管理员自己的个人助手。
 *
 * 身份与 voice_send 同一条回环通道：桥接每轮把 QQ 会话绑进临时凭据
 * （QQ_BRIDGE_ENDPOINT / QQ_BRIDGE_TOKEN，与 QQ_VOICE_TOKEN 同一枚）。
 * 本工具只提交 text。提问者是谁、回发到哪个会话，由桥接按 OneBot 事件填写；
 * 模型参数里即使带了别的字段也不会被转发。
 *
 * 个人助手的地址不在这里写死。管理员在 config.json 的 bridge.personalAgent
 * 里 configure yourself（只接受本机回环）。即时推送失败时桥接改写信箱。
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

/** 与 src/tell-guga.ts 的 TELL_MAX_CHARS 保持一致。 */
const MAX_TEXT_LEN = 4000;

const SCHEMA = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "要转达给本机个人助手的完整内容（对它的留言，不是给用户看的）。它看不到 QQ 群聊，请写清背景与要它做什么。不要填写提问者或回发目标。",
    },
  },
  required: ["text"],
};

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

export default function bridgeToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "tell_guga",
    label: "Tell Guga",
    description: "把一条留言转达给管理员本机的个人助手。只有院长可以触发；身份由桥接按本轮 QQ 会话判定。",
    promptSnippet: "tell_guga: relay a message to the owner's own local personal agent",
    promptGuidelines: [
      "仅当来源标注为「院长」的人让你给本机个人助手带话、转达、交代事情时调用；其他人一律拒绝，不要调用。",
      "只填写 text。不要填写提问者 QQ、群号或回发目标；桥接会按这一轮 QQ 会话绑定，模型填了也无效。",
      "个人助手是管理员自己在本机配置的程序，看不到 QQ 群聊；text 里写清背景和要它做什么。",
      "它不在任何群里，不要把它当群友去翻名册。",
      "工具返回什么就如实转告。返回失败时不要声称已经转达。",
      "回发是给 QQ 里的人看的：只转发它针对原问题的简洁答复，别把工作报告、查证过程或文件路径原样转过来。",
    ],
    parameters: SCHEMA,
    async execute(_id, params) {
      const endpoint = process.env.QQ_BRIDGE_ENDPOINT ?? "";
      const token = process.env.QQ_BRIDGE_TOKEN ?? "";
      if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/tell-guga$/.test(endpoint) || !/^[a-f0-9]{64}$/.test(token)) {
        return text("本次会话没有转达权限，没有提交给本机个人助手。");
      }
      const body = String(params.text ?? "").trim();
      if (!body) return text("要转达的内容为空。");
      if (body.length > MAX_TEXT_LEN) return text(`内容太长（${body.length} 字），请压缩到 ${MAX_TEXT_LEN} 字以内。`);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ text: body }),
          signal: AbortSignal.timeout(20000),
          redirect: "error",
        });
        const value = await response.json() as { text?: string };
        if (typeof value.text !== "string") return text("转达服务返回异常，没有提交成功。");
        return text(value.text);
      } catch {
        return text("转达服务不可用，没有提交给本机个人助手。");
      }
    },
  });
}
