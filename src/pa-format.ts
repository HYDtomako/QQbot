/**
 * 本机个人助手（PA）回发内容的整理：PA 的完整回复常带着查证过程、进程号、
 * 文件路径和 Markdown（那是它给自己看的报告），不该整段转发到 QQ。
 * 这里把长回复提炼成「针对原问题的简洁答复」，短回复不动。
 */

export const PA_COMPACT_THRESHOLD = 800; // 超过这个字符数才整理
export const PA_REPLY_MAX_CHARS = 400; // 整理后的目标上限

export interface PaCompactOptions {
  /** 回复发往何处（group:群号 / private:QQ号），只用于让整理模型判断来源，不参与内容 */
  via?: string;
  threshold?: number;
  maxChars?: number;
  timeoutMs?: number;
}

/** 判断一条 PA 回发是否需要整理：过长，或带代码块/表格/多级标题。 */
export function needsPaCleanup(text: string, threshold: number = PA_COMPACT_THRESHOLD): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.length > threshold) return true;
  return t.includes("```") || /^\s*\|.*\|\s*$/m.test(t) || /^#{1,6}\s/m.test(t);
}

/** 整理提示词：写死「只回答原问题、不搬运过程」，让无工具的一次调用直接吐干净结论。 */
export function buildCompactPrompt(text: string, maxChars: number, via?: string): string {
  const target = via?.startsWith("group:") ? `QQ 群 ${via.slice(6)}` : via?.startsWith("private:") ? "QQ 私聊" : "QQ";
  return (
    `下面是一台电脑上的 AI 助手发给 ${target} 的回复全文。请改写成适合直接发到 QQ 的答复：\n` +
    `- 只回答原问题本身：先给结论，再给必要的要点；最多 3 条，总长不超过 ${maxChars} 字；\n` +
    `- 删掉一切过程与工作细节：查证步骤、进程号/PID、文件路径、命令、代码、配置项、日志、备份位置、内部工具名、时间戳；\n` +
    `- 删掉 Markdown 标记（加粗星号、反引号、井号标题、列表符号）与多余空行；\n` +
    `- 保留对方需要的东西：结论、必要的状态或数字、需要他做的事；\n` +
    `- 纯文本、口语化，直接写答复本身，不要任何前言（如"好的""以下是改写"）。\n\n` +
    `回复全文：\n${text}`
  );
}

/**
 * 清洗整理结果：剥掉模型可能加的 Markdown 围栏或前缀，超长时在句子边界截断。
 * 结果为空（模型没吐出可用内容）时返回空串，由调用方回退。
 */
export function sanitizeCompact(raw: string, maxChars: number): string {
  const s = raw
    .trim()
    .replace(/^```[\w-]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    // 开场白（"好的，""以下是…："）去掉；"结论：""答复："这类是正经格式，保留
    .replace(/^(?:好的|好|行|明白|收到)[，,：:!！。\s]*/, "")
    .replace(/^(?:以下|下面|其中)[^\n：:]{0,10}[：:]\s*/, "")
    .trim();
  if (s.length <= maxChars) return s;
  const window = s.slice(0, maxChars);
  const sentenceCuts = [...window.matchAll(/[。！？!?；;]+[”"』）)】]?|\.\s/g)].map((m) => m.index! + m[0].length);
  const nl = window.lastIndexOf("\n");
  const cut = sentenceCuts.filter((i) => i >= maxChars / 2).pop() ?? (nl >= maxChars / 2 ? nl : -1);
  return (cut > 0 ? window.slice(0, cut) : window).trim();
}

/**
 * 把 PA 的长回复整理成简洁答复。runModel 由调用方注入（单次无工具 pi 调用）；
 * 整理失败或结果为空时返回空串，调用方自行回退原文。
 */
export async function compactPaReply(
  text: string,
  runModel: (prompt: string, timeoutMs: number) => Promise<string>,
  options: PaCompactOptions = {},
): Promise<string> {
  const maxChars = options.maxChars ?? PA_REPLY_MAX_CHARS;
  const timeoutMs = options.timeoutMs ?? 90_000;
  let out = "";
  try {
    out = await runModel(buildCompactPrompt(text.trim(), maxChars, options.via), timeoutMs);
  } catch {
    return "";
  }
  return sanitizeCompact(out, maxChars);
}
