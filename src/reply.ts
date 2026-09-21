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
