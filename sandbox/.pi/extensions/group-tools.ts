/**
 * group-tools 扩展：让企鹅主任认识群里的每个人（QQ 号为唯一标识）。
 *
 * 数据来源：桥接服务定期把 OneBot 的群成员列表写入 sandbox/.roster/<群号>.json，
 * 本扩展只读本地名册文件（进退群时桥接会即时刷新）。
 * 不提供任何管理动作（踢人/改名片等），仅作认识与核对之用。
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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rosterDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.roster");

const ROLE_NAMES: Record<string, string> = { owner: "群主", admin: "管理员", member: "成员" };

interface RosterMember {
  user_id: number;
  card?: string;
  nickname?: string;
  role?: string;
  join_time?: number;
  last_sent_time?: number;
}

interface Roster {
  updatedAt: string;
  members: RosterMember[];
}

const MEMBERS_SCHEMA = {
  type: "object",
  properties: {
    group_id: { type: "string", description: "群号；不填且当前只有一份名册时自动使用它" },
  },
  required: [],
};

const INFO_SCHEMA = {
  type: "object",
  properties: {
    user_id: { type: "string", description: "对方的 QQ 号（唯一标识）" },
    group_id: { type: "string", description: "群号；不填则在所有名册中查找" },
  },
  required: ["user_id"],
};

function loadRoster(groupId: string): Roster | null {
  const file = path.join(rosterDir, `${groupId}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Roster;
  } catch {
    return null;
  }
}

function availableGroupIds(): string[] {
  if (!existsSync(rosterDir)) return [];
  return readdirSync(rosterDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

function displayName(m: RosterMember): string {
  const card = (m.card ?? "").trim();
  const nick = (m.nickname ?? "").trim();
  if (card && nick && card !== nick) return `${card}（昵称 ${nick}）`;
  return card || nick || "（未知名片）";
}

function fmtTime(unix?: number): string {
  if (!unix) return "未知";
  return new Date(unix * 1000).toLocaleString("zh-CN", { hour12: false });
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

export default function groupToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "group_members",
    label: "Group Members",
    description: "查询群成员名册：每个人的 QQ 号、群名片、昵称、群身份（群主/管理员/成员）。",
    promptSnippet: "group_members: look up the group member roster",
    promptGuidelines: [
      "需要认识某人、核对身份、称呼群友或做群务相关回答时，先查名册，以 QQ 号为准。",
    ],
    parameters: MEMBERS_SCHEMA,
    async execute(_id, params) {
      const ids = availableGroupIds();
      if (ids.length === 0) return text("名册为空（尚未从服务器同步），稍后再试。");
      const wanted = String(params.group_id ?? "").trim();
      const groupId = wanted || (ids.length === 1 ? ids[0] : "");
      if (!groupId) return text(`当前有多份群名册（${ids.join("、")}），请指定群号。`);
      const roster = loadRoster(groupId);
      if (!roster) return text(`没有群 ${groupId} 的名册，可用名册：${ids.join("、")}`);

      const order: Record<string, number> = { owner: 0, admin: 1, member: 2 };
      const members = [...roster.members].sort(
        (a, b) => (order[a.role ?? "member"] ?? 3) - (order[b.role ?? "member"] ?? 3) || a.user_id - b.user_id,
      );
      const lines = members.map(
        (m) => `${m.user_id}  ${ROLE_NAMES[m.role ?? ""] ?? m.role ?? "成员"}  ${displayName(m)}`,
      );
      return text(
        `群 ${groupId} 成员名册（共 ${members.length} 人，更新于 ${roster.updatedAt}）：\n\n${lines.join("\n")}\n\n注意：识别身份以 QQ 号为唯一标识，名片/昵称随时可改。`,
      );
    },
  });

  pi.registerTool({
    name: "member_info",
    label: "Member Info",
    description: "按 QQ 号查询某个群成员的详情：群名片、昵称、群身份、入群时间、最后发言时间。",
    promptSnippet: "member_info: look up one member by QQ number",
    promptGuidelines: [
      "对某个具体的人不确定是谁时，用其 QQ 号查询详情。",
    ],
    parameters: INFO_SCHEMA,
    async execute(_id, params) {
      const userId = String(params.user_id ?? "").trim();
      if (!userId) return text("请提供对方的 QQ 号。");
      const wantedGroup = String(params.group_id ?? "").trim();
      const ids = wantedGroup ? [wantedGroup] : availableGroupIds();
      if (ids.length === 0) return text("名册为空（尚未从服务器同步），稍后再试。");

      for (const gid of ids) {
        const roster = loadRoster(gid);
        const m = roster?.members.find((x) => String(x.user_id) === userId);
        if (m && roster) {
          return text(
            [
              `QQ ${userId} 在群 ${gid} 的信息（名册更新于 ${roster.updatedAt}）：`,
              `- 群身份：${ROLE_NAMES[m.role ?? ""] ?? m.role ?? "成员"}`,
              `- 群名片：${(m.card ?? "").trim() || "未设置"}`,
              `- 昵称：${(m.nickname ?? "").trim() || "未知"}`,
              `- 入群时间：${fmtTime(m.join_time)}`,
              `- 最后发言：${fmtTime(m.last_sent_time)}`,
            ].join("\n"),
          );
        }
      }
      return text(`名册中没有 QQ ${userId}（可能刚进群，名册每 10 分钟自动刷新；进退群时会即时刷新）。`);
    },
  });
}
