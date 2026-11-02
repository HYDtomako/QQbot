/**
 * mode_manage 的桥接侧实现。
 *
 * 谁能改模式只看本轮回环凭据绑上的 QQ（与 voice_send / tell_guga 同一枚 token）。
 * 群聊要操作的群也取自这轮会话，不接受模型另报的群号。
 * 私聊没有当前群：可以用 group_id 指定，否则用配置里的默认群。
 */

export interface ModeManageRequest {
  /** 桥接从 OneBot 事件绑定的提问者，不是模型参数。 */
  asker: string;
  owner: string;
  kind: "group" | "private";
  /** 群聊会话的群号。私聊为空。 */
  sessionGroupId?: string;
  defaultGroup?: string;
  op: unknown;
  /** 模型提交的目标群。群聊里忽略；私聊里作为业务参数。 */
  groupId: unknown;
}

export interface ModeManageResult {
  ok: boolean;
  text: string;
  /** 有值时桥接应在本轮回复发出后写入 modes.json。拒绝时绝不带这个字段。 */
  next?: Record<string, unknown>;
}

const GROUP_ID = /^\d{5,12}$/;

function deny(text: string): ModeManageResult {
  return { ok: false, text };
}

function groupsOf(raw: Record<string, unknown> | null): string[] {
  const entertainment = raw?.entertainment;
  if (!entertainment || typeof entertainment !== "object" || Array.isArray(entertainment)) return [];
  const groups = (entertainment as { groups?: unknown }).groups;
  return Array.isArray(groups) ? groups.map(String) : [];
}

function targetGroup(input: ModeManageRequest): { id: string } | { error: string } {
  if (input.kind === "group") {
    const id = String(input.sessionGroupId ?? "").trim();
    if (!GROUP_ID.test(id)) return { error: "当前会话没有可用的群号。" };
    return { id };
  }
  const requested = typeof input.groupId === "string" ? input.groupId.trim() : "";
  const id = requested || String(input.defaultGroup ?? "").trim();
  if (!id) return { error: "没指定群号，配置里也没有默认群。" };
  if (!GROUP_ID.test(id)) return { error: "群号格式不对，请用纯数字群号。" };
  return { id };
}

export function runModeManage(input: ModeManageRequest, raw: Record<string, unknown> | null): ModeManageResult {
  const asker = String(input.asker ?? "").trim();
  const owner = String(input.owner ?? "").trim();
  if (!owner || !asker || asker !== owner) return deny("只有院长可以管理娱乐模式。");

  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const groups = groupsOf(base);
  const op = String(input.op ?? "").trim();

  if (op === "status") {
    return {
      ok: true,
      text: groups.length ? `已开启娱乐模式的群：${groups.join("、")}` : "目前没有开启娱乐模式的群。",
    };
  }
  if (op !== "on" && op !== "off") return deny("未知操作，应为 status / on / off。");

  const target = targetGroup(input);
  if ("error" in target) return deny(target.error);

  const set = new Set(groups);
  const on = op === "on";
  if (on) set.add(target.id);
  else set.delete(target.id);
  const entertainment = base.entertainment;
  const prev = entertainment && typeof entertainment === "object" && !Array.isArray(entertainment)
    ? entertainment as Record<string, unknown>
    : {};
  return {
    ok: true,
    text: `娱乐模式已${on ? "开启" : "关闭"}：群 ${target.id}。`,
    next: {
      ...base,
      entertainment: { ...prev, groups: [...set] },
    },
  };
}
