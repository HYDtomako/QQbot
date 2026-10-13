export interface InternalReply {
  text: string;
  sticker: string | null;
}

// 仅匹配完整的单层 JSON/无语言围栏，不剥离正文、其他语言或嵌套围栏。
const JSON_FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```$/i;
const JSON_STRING = /"(?:\\.|[^"\\])*"/g;
const NORMAL_FALLBACK = "我在，有什么想聊的？";

// 有限的格式请求启发式：要求指令/示例语境，而不是看到 JSON 一词就豁免。
const LITERAL_REQUESTS = [
  /(?:用|使用|以|按(?:照)?)\s*(?:json|xml|yaml|结构化(?:数据)?|代码|协议)(?:\s*(?:格式|形式))?\s*(?:输出|返回|回复|回答|展示|给出)/i,
  /(?:输出|返回|回复|给我|给出|提供|生成|展示|写|举)[^\r\n。！？!?；;，,]{0,24}(?:json|xml|yaml|结构化|代码|源码|协议|原文)/i,
  /(?:请|麻烦)\s*(?:用|使用|以|按(?:照)?|保留)\s*(?:json|xml|yaml|结构化|代码|源码|协议|原文)/i,
  /(?:代码|源码)\s*(?:示例|例子|样例|片段|原文)|(?:示例|样例)\s*代码|(?:原样|逐字)\s*(?:输出|返回|保留|展示|复制)/i,
  /\b(?:return|output|respond|reply|show|give|provide|generate|write|preserve|keep)\b[^\r\n.!?;,]{0,48}\b(?:json|xml|yaml|structured|code|source|protocol|verbatim|raw)\b/i,
  /\b(?:json|code|protocol)\s+(?:only|example|sample)\b/i,
  /^\s*(?:json|xml|yaml|结构化|代码|协议)(?:\s*(?:格式|示例|原文))?[。.!！]?\s*$/i,
];

function requestsLiteralReply(userText: string): boolean {
  // “不要输出 JSON，正常说话”不是格式请求；仅排除紧邻的常见否定指令。
  const request = userText.replace(
    /(?:不要|不用|无需|不必|别|勿)\s*(?:(?:再|给我|用|使用|以|按|按照|输出|返回|回复|提供|生成|展示)\s*)*(?:json|xml|yaml|结构化|代码|源码|协议|原文)(?:格式)?/gi,
    "",
  );
  return LITERAL_REQUESTS.some((pattern) => pattern.test(request));
}

/** 只读取整条严格内部协议；不读取配置、素材清单或从正文抽取 JSON。 */
export function readInternalReply(raw: string): InternalReply | null {
  const trimmed = raw.trim();
  const candidate = JSON_FENCE.exec(trimmed)?.[1].trim() ?? trimmed;
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) return null;

  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("text") || !keys.includes("sticker")) return null;
  if (typeof record.text !== "string") return null;
  const sticker = record.sticker;
  // 与 stickers.ts 的 ID 字符集一致；拒绝空串及任何空白（包括末尾换行）。
  if (sticker !== null && (typeof sticker !== "string" || !sticker || /[^a-z0-9_-]/.test(sticker))) {
    return null;
  }
  // JSON.parse 会吞掉重复键。已确定两个值均为字符串/null，去掉字符串后
  // 必须恰有两个成员冒号；不把 text 内容里的引号、冒号或字段名算进去。
  if (candidate.replace(JSON_STRING, "").split(":").length !== 3) return null;
  return { text: record.text, sticker };
}

export function isInternalReply(raw: string): boolean {
  return readInternalReply(raw) !== null;
}

/** 正常模式发送兜底；明确请求结构化/代码原文时，连空协议也原样保留。 */
export function normalReplyText(raw: string, userText: string): string {
  const reply = readInternalReply(raw);
  if (reply === null || requestsLiteralReply(userText)) return raw;
  return reply.text.trim() ? reply.text : NORMAL_FALLBACK;
}

/** 仅用于机器人历史，调用方必须先判断身份，绝不能用于用户消息。 */
export function recordedReplyText(raw: string): string {
  const reply = readInternalReply(raw);
  if (reply === null) return raw;
  return reply.text.trim() ? reply.text : "";
}
