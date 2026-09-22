import type { MessageSegment } from "./onebot.ts";

export const MAX_SEGMENT_LEN = 4000; // QQ 单条消息上限约 4500 字符，留余量

export function textSegment(text: string): MessageSegment {
  return { type: "text", data: { text } };
}

export function atSegment(userId: string): MessageSegment {
  return { type: "at", data: { qq: userId } };
}

/** 按字符数分片，段边界优先找换行，避免把一句话从中间劈开。 */
export function splitText(text: string, maxLen: number = MAX_SEGMENT_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut <= maxLen / 2) cut = maxLen; // 没有合适换行点就硬切
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}

export const CARD_NODE_LEN = 500; // 群聊卡片里单条消息的目标字数：超过就按这个字数分段

/** 返回窗口内最后一个空行之后的位置（找不到返回 -1）。 */
function lastBlankLine(win: string): number {
  let cut = -1;
  for (const m of win.matchAll(/\n[ \t]*\n/g)) cut = m.index! + m[0].length;
  return cut;
}

/** 返回窗口内最后一个句末标点之后的位置（找不到返回 -1）。 */
function lastSentenceEnd(win: string): number {
  let cut = -1;
  // 中文句末标点；英文的 ". " 要求点后跟空白，避免把 3.5 / e.g. 当成句号
  for (const m of win.matchAll(/[。！？!?；;]+[”"』）)】]?|\.\s/g)) cut = m.index! + m[0].length;
  return cut;
}

/**
 * 把长文按 maxLen 字数切段：每段尽量写满，只在上限附近挑一个体面的断点
 * （空行 → 换行 → 句末标点 → 空格），都没有才硬切。
 */
function splitLong(s: string, maxLen: number): string[] {
  const out: string[] = [];
  let rest = s.trim();
  const floor = maxLen * 0.5; // 断点太靠前就不认，保证每段都接近目标字数
  while (rest.length > maxLen) {
    const win = rest.slice(0, maxLen);
    const blank = lastBlankLine(win);
    const nl = win.lastIndexOf("\n");
    const sent = lastSentenceEnd(win);
    const sp = win.lastIndexOf(" ");
    const cut =
      blank >= floor ? blank
      : nl >= floor ? nl + 1
      : sent >= floor ? sent
      : sp >= floor ? sp + 1
      : maxLen;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) {
    // 尾巴太短就并回上一段，避免冒出一条只有几个字的消息
    const last = out[out.length - 1];
    if (last && rest.length < maxLen * 0.3) out[out.length - 1] = `${last}\n${rest}`;
    else out.push(rest);
  }
  return out;
}

/**
 * 群聊"聊天记录"卡片的分条：一大段文字按固定字数（CARD_NODE_LEN）切成几条，
 * 不超过字数就不分，私聊不走这里。
 */
export function splitForCard(text: string, maxLen: number = CARD_NODE_LEN): string[] {
  const t = text.trim();
  if (!t) return [text];
  return t.length <= maxLen ? [t] : splitLong(t, maxLen);
}

/** 把回复组装成适合 QQ 发送的消息段列表（群聊先 @ 提问者）。 */
export function buildReply(
  trigger: { kind: "private" | "group"; userId: string },
  text: string,
): MessageSegment[][] {
  const chunks = splitText(text);
  return chunks.map((chunk, i) => {
    const segs: MessageSegment[] = [];
    if (trigger.kind === "group" && i === 0) segs.push(atSegment(trigger.userId));
    segs.push(textSegment(chunk));
    return segs;
  });
}
