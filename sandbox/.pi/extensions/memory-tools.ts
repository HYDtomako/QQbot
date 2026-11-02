/**
 * memory-tools：把长期记忆的记/查/删交给桥接。
 *
 * 身份与 voice_send 同一条回环通道（QQ_MEMORY_ENDPOINT / QQ_MEMORY_TOKEN）。
 * 三个工具只提交业务字段。提问者 QQ 由桥接按本轮 OneBot 事件填写，
 * 档案也按这个 QQ 分开。模型填了别的号码也不会被转发。
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

/** 与 src/memory-tool.ts 的 MEMORY_MAX_TEXT 保持一致。 */
const MAX_TEXT_LEN = 200;

const SCHEMA_REMEMBER = {
  type: "object",
  properties: {
    text: { type: "string", description: "要长期记住的事实（一句话，不超过 200 字）" },
    pinned: { type: "boolean", description: "是否为核心信息（身份、长期偏好等）。核心信息每次对话都会带上；临时安排不设" },
  },
  required: ["text"],
};

const SCHEMA_RECALL = {
  type: "object",
  properties: {
    query: { type: "string", description: "可选：检索关键词，不填则列出全部" },
  },
  required: [],
};

const SCHEMA_FORGET = {
  type: "object",
  properties: {
    target: { type: "string", description: "要删除的记忆 id 或文本片段" },
  },
  required: ["target"],
};

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

async function postMemory(payload: Record<string, unknown>): Promise<ToolResult> {
  const endpoint = process.env.QQ_MEMORY_ENDPOINT ?? "";
  const token = process.env.QQ_MEMORY_TOKEN ?? "";
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/memory$/.test(endpoint) || !/^[a-f0-9]{64}$/.test(token)) {
    return text("本次会话没有记忆权限。");
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    const value = await response.json() as { text?: string };
    if (typeof value.text !== "string") return text("记忆服务返回异常。");
    return text(value.text);
  } catch {
    return text("记忆服务不可用。");
  }
}

export default function memoryToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "remember",
    label: "Remember",
    description: "把一条事实写入长期记忆（永久保留、以后相关对话会带上）。只有院长可以写入；身份由桥接按本轮 QQ 会话判定。",
    promptSnippet: "remember: persist a fact about the user across sessions",
    promptGuidelines: [
      "当院长说\"记住…\"\"以后记得…\"\"别忘了…\"时调用；写入后简短确认已记住。",
      "只记明确要求记的、或明显长期有效的信息（身份、偏好、长期安排）。不要记普通闲聊、一次性问题、临时信息。",
      "身份类信息（学号、班级、姓名、长期偏好）设 pinned=true；临时安排、具体某天的任务不设。",
      "不要填写提问者 QQ。桥接按这一轮会话判断是谁，并写入这个人自己的档案；填了也无效。只有院长可以写入，其他人要求记住时礼貌说明只有院长可以，不调用工具。",
    ],
    parameters: SCHEMA_REMEMBER,
    async execute(_id, params) {
      const raw = String(params.text ?? "").trim();
      if (!raw) return text("要记住的内容为空。");
      if (raw.length > MAX_TEXT_LEN) return text(`内容太长（${raw.length} 字），请压缩到 ${MAX_TEXT_LEN} 字以内。`);
      const payload: Record<string, unknown> = { op: "remember", text: raw };
      if (params.pinned === true) payload.pinned = true;
      return postMemory(payload);
    },
  });

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "查询长期记忆里的条目（默认列出全部，可按关键词检索）。只查本轮提问者自己的档案。",
    promptSnippet: "recall: list or search the user's long-term memory",
    promptGuidelines: [
      "院长问\"你记得我什么\"\"我让你记过什么\"时调用；也可以在你需要确认某个久远事实时主动查。",
      "不要填写提问者 QQ。桥接只打开这一轮会话对应的档案，查不到别人的记忆。",
    ],
    parameters: SCHEMA_RECALL,
    async execute(_id, params) {
      const payload: Record<string, unknown> = { op: "recall" };
      const query = String(params.query ?? "").trim();
      if (query) payload.query = query;
      return postMemory(payload);
    },
  });

  pi.registerTool({
    name: "forget",
    label: "Forget",
    description: "删除长期记忆里的条目（按 id 或文本片段匹配）。只有院长可以删除；身份由桥接按本轮 QQ 会话判定。",
    promptSnippet: "forget: delete entries from long-term memory",
    promptGuidelines: [
      "院长说\"忘掉…\"\"删掉那条记忆\"时调用；删除前把将删除的条目原文复述给他确认。",
      "不要填写提问者 QQ。桥接按这一轮会话判断是谁；只有院长可以删除，填了别的号码也无效。",
    ],
    parameters: SCHEMA_FORGET,
    async execute(_id, params) {
      const target = String(params.target ?? "").trim();
      if (!target) return text("要删除哪条？给我 id 或文本片段。");
      return postMemory({ op: "forget", target });
    },
  });
}
