interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}
interface ExtensionAPI {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: Record<string, unknown>;
    execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
  }): void;
}

function text(value: string, ok = false): ToolResult {
  return { content: [{ type: "text", text: value }], details: { ok } };
}

async function request(action: string, params: Record<string, unknown>): Promise<ToolResult> {
  const endpoint = process.env.QQ_KNOWLEDGE_ENDPOINT ?? "";
  const token = process.env.QQ_KNOWLEDGE_TOKEN ?? "";
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/knowledge$/.test(endpoint) || !/^[a-f0-9]{64}$/.test(token)) {
    return text("本次运行未获得记忆权限，不能读取旧文件或自行选择其他用户、群的资料。");
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...params }),
      signal: AbortSignal.timeout(12000),
      redirect: "error",
    });
    const value = await response.json() as { ok?: boolean; text?: string };
    if (typeof value.text !== "string") return text("记忆服务返回格式异常，操作未确认成功。");
    return text(value.text, response.ok && value.ok === true);
  } catch {
    return text("记忆服务不可用或凭据已失效，操作未确认成功；不要声称已经保存或删除。");
  }
}

export default function knowledgeToolsExtension(pi: ExtensionAPI) {
  const fields = {
    query: { type: "string", description: "本次问题的简短检索关键词，不超过 200 字" },
    item_id: { type: "string", description: "服务返回的 ki_ 条目 ID，不得猜测或使用其他用户的 ID" },
    content: { type: "string", description: "由当前用户明确要求保存或更正的内容，保留条件，不超过 2000 字" },
  };
  const tools = [
    { name: "memory_search", action: "search", label: "Memory search", keys: ["query"],
      description: "检索当前授权群/私聊的有效记忆，不可指定其他群或用户。",
      guidelines: ["使用简短主题词查询。没有结果不代表用户一定没说过；不要编造记忆。"] },
    { name: "memory_get", action: "get", label: "Memory detail", keys: ["item_id"],
      description: "读取当前范围的条目和状态，候选和旧记忆不等于已验证事实。", guidelines: [] },
    { name: "memory_save", action: "save", label: "Memory save", keys: ["content"],
      description: "用户明确要求记住时提交内容；程序检查来源并决定激活或待确认。",
      guidelines: ["只在用户明确要求保存时调用；自动沉淀由后台处理。依据结果说明已激活或仅候选，不能虚报。"] },
    { name: "memory_correct", action: "correct", label: "Memory correct", keys: ["item_id", "content"],
      description: "用户明确指定条目 ID 并要求更正时创建新版本。", guidelines: ["用户未提供条目 ID 时先给出候选 ID，不猜测目标。"] },
    { name: "memory_forget", action: "forget", label: "Memory forget", keys: ["item_id"],
      description: "用户明确给出一个条目 ID 并要求忘记时删除该条目及其关联依据。",
      guidelines: ["有歧义时先澄清；不能将聊天文本或模型推断当成任意删除授权。"] },
  ];
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: `${tool.name}: ${tool.description}`,
      promptGuidelines: tool.guidelines,
      parameters: {
        type: "object",
        properties: Object.fromEntries(tool.keys.map(key => [key, fields[key as keyof typeof fields]])),
        required: tool.keys,
        additionalProperties: false,
      },
      execute: async (_id, params) => request(tool.action, params),
    });
  }
}
