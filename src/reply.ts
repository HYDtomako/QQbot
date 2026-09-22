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

export const CARD_NODE_LEN = 200; // 群聊卡片里单条消息的目标长度，超出就分成多条

/** 返回窗口内最后一个句末标点之后的位置（找不到返回 -1）。 */
function lastSentenceEnd(win: string): number {
  let cut = -1;
  // 中文句末标点；英文的 ". " 要求点后跟空白，避免把 3.5 / e.g. 当成句号
  for (const m of win.matchAll(/[。！？!?；;]+[”"』）)】]?|\.\s/g)) cut = m.index! + m[0].length;
  return cut;
}

/** 把一段过长的文本按换行/句末标点切成不超长的片段，都没有就退到空格、再没有才硬切。 */
function splitLong(s: string, maxLen: number): string[] {
  const out: string[] = [];
  let rest = s.trim();
  while (rest.length > maxLen) {
    const win = rest.slice(0, maxLen);
    const floor = maxLen * 0.3; // 断点太靠前不如继续往后找，避免切出只有几个字的碎片
    const nl = win.lastIndexOf("\n");
    const sent = lastSentenceEnd(win);
    const sp = win.lastIndexOf(" ");
    const cut =
      nl >= floor ? nl + 1 : sent >= floor ? sent : sp >= maxLen * 0.6 ? sp + 1 : maxLen;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * 群聊"聊天记录"卡片的分条：按空行 → 换行 → 句末标点的优先级断开，
 * 让回复落成若干条短消息，而不是一整段塞进一条。
 */
export function splitForCard(text: string, maxLen: number = CARD_NODE_LEN): string[] {
  const nodes: string[] = [];
  const push = (piece: string): void => {
    const t = piece.trim();
    if (!t) return;
    const last = nodes[nodes.length - 1];
    // 太短的尾巴并回上一条，避免冒出一条只有几个字的消息
    if (last && t.length < 20 && last.length + t.length < maxLen) nodes[nodes.length - 1] = `${last}\n${t}`;
    else nodes.push(t);
  };
  for (const para of text.split(/\n\s*\n/)) {
    for (const line of para.split("\n")) {
      for (const piece of line.length > maxLen ? splitLong(line, maxLen) : [line]) push(piece);
    }
  }
  return nodes.length ? nodes : [text.trim()];
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
