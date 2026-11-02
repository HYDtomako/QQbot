/**
 * send_group_message 的桥接侧实现。
 *
 * 谁能往群里发消息只看本轮回环凭据绑上的 QQ。
 * 目标群号是业务参数（不填则用默认群），不是提问者身份。
 */

export const SEND_MAX_CHARS = 3000;

export interface SendGroupRequest {
  /** 桥接从 OneBot 事件绑定的提问者，不是模型参数。 */
  asker: string;
  owner: string;
  text: unknown;
  /** 模型提交的目标群。可以指定；空则用默认群。 */
  groupId: unknown;
  defaultGroup?: string;
}

export interface SendGroupResult {
  ok: boolean;
  text: string;
  /** 有值时桥接应写入发件箱。拒绝时绝不带这个字段。 */
  message?: { group_id: string; text: string };
}

function deny(text: string): SendGroupResult {
  return { ok: false, text };
}

export function runSendGroup(input: SendGroupRequest): SendGroupResult {
  const asker = String(input.asker ?? "").trim();
  const owner = String(input.owner ?? "").trim();
  if (!owner || !asker || asker !== owner) return deny("只有院长可以让我往群里发消息。");

  const body = typeof input.text === "string" ? input.text.trim() : "";
  if (!body) return deny("要发送的内容为空。");
  if (body.length > SEND_MAX_CHARS) return deny(`内容太长（${body.length} 字），请压缩到 ${SEND_MAX_CHARS} 字以内。`);

  const requested = typeof input.groupId === "string"
    ? input.groupId.trim()
    : input.groupId == null ? "" : String(input.groupId).trim();
  const groupId = requested || String(input.defaultGroup ?? "").trim();
  if (!groupId) return deny("没指定群号，且配置里也没有默认群。");

  return {
    ok: true,
    text: `已提交，几秒内会发送到群 ${groupId}。内容：\n${body}`,
    message: { group_id: groupId, text: body },
  };
}
