/**
 * voice-tools 扩展：让模型在娱乐模式群里把一段话合成语音发到当前群。
 *
 * 机制（与 mode_manage 同一套桥接路由）：工具把 text/voice 提交给桥接开在本机的
 * 回环 HTTP 通道（/voice-send），由桥接判定会话模式与权限，再调 MiniMax 合成、
 * 用 OneBot 的 record 段发到当前群。工具本身不接触 OneBot 连接，也不读密钥。
 *
 * 权限由桥接侧强制（当前回合是否娱乐模式群、发起人是否院长/白名单/allowOthers）。
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
    text: {
      type: "string",
      description: "要朗读的文字（必填，纯口语文本）：去掉 Markdown、代码、链接、@、表情包标注；不要分点或换行；建议 50 字以内，最多 200 字。",
    },
    voice: {
      type: "string",
      description:
        "可选音色：中文名或 voice_id 都可以（少女 / 御姐 / 成熟女性 / 甜美 / 青涩青年 / 精英青年 / 霸道青年 / 青年大学生 / 萌女童 / 男童）。不填或填错会用默认音色。",
    },
  },
  required: ["text"],
};

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

export default function voiceToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "voice_send",
    label: "Voice Send",
    description:
      "把一段短文本合成 QQ 语音（record）发到当前娱乐模式群。只在娱乐模式群可用；" +
      "只在用户明确要求“用语音说/念/读/发语音”时使用；不要对长文、代码、链接使用。",
    promptSnippet: "voice_send: speak a short text as a QQ voice message in the current entertainment group",
    promptGuidelines: [
      "仅当当前是娱乐模式群、且消息来源标注里的人明确要求“用语音说 / 念一遍 / 读出来 / 发语音”时才调用；普通模式群、私聊里不要调用（桥接会拒绝）。",
      "text 是要朗读的纯口语文字：去掉 Markdown、代码、链接、@ 和表情包标注，不要换行，最多 200 字；课表、长文先概括成几句再说，念不下就用文字回答。",
      "voice 可选，中文名或 voice_id 都行：少女、御姐、成熟女性、甜美、青涩青年、精英青年、霸道青年、青年大学生、萌女童、男童；用户没指定就用默认，不要自己编 voice_id。",
      "工具返回成功后本轮就结束了：不要再发任何文字或表情包，也别回「好」之类的确认，不要重复朗读内容。",
      "工具返回失败（非娱乐模式、无权限、功能关闭、太长、合成/发送失败）时，照常用文字回答，不要声称已经发过语音。",
    ],
    parameters: SCHEMA,
    async execute(_id, params) {
      const endpoint = process.env.QQ_VOICE_ENDPOINT ?? "";
      const token = process.env.QQ_VOICE_TOKEN ?? "";
      if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/voice-send$/.test(endpoint) || !/^[a-f0-9]{64}$/.test(token)) {
        return text("本次会话没有语音权限，语音没有发出，请直接用文字回复。");
      }
      const body = String(params.text ?? "");
      const voice = String(params.voice ?? "").trim();
      if (!body.trim()) return text("没有要朗读的文字，语音没有发出，请直接用文字回复。");
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(voice ? { text: body, voice } : { text: body }),
          signal: AbortSignal.timeout(25000),
          redirect: "error",
        });
        const value = await response.json() as { ok?: boolean; text?: string };
        if (typeof value.text !== "string") return text("语音服务返回格式异常，语音没有发出，请直接用文字回复。");
        return text(value.text);
      } catch {
        return text("语音服务不可用，语音没有发出，请直接用文字回复。");
      }
    },
  });
}
