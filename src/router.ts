export interface ImageRef {
  /** NapCat 给的本地路径或文件名 */
  file?: string;
  /** OneBot file_id（用于调 get_image） */
  fileId?: string;
  /** 图片 CDN 链接 */
  url?: string;
}

export interface FileRef {
  /** OneBot file_id（用于调 get_file 下载） */
  fileId?: string;
  /** 原始文件名（含扩展名） */
  name?: string;
  /** 下载链接（部分场景提供） */
  url?: string;
  size?: number;
}

export interface TriggeredMessage {
  kind: "private" | "group";
  userId: string;
  groupId?: string;
  text: string;
  /** 群聊时的发送者显示名（群名片优先，其次昵称），用于"回复 @谁"。 */
  senderName?: string;
  /** 群聊时发送者的群身份（owner/admin/member），来自事件 sender.role。 */
  senderRole?: string;
  /** 消息里携带的图片（可能为空） */
  images?: ImageRef[];
  /** 消息里携带的文件（QQ 文件消息，可能为空） */
  files?: FileRef[];
  /** 消息引用的被回复消息 id（QQ 的"引用回复"，图片常在引用消息里） */
  replyIds?: string[];
}

/**
 * 判断一条 OneBot 消息事件是否应触发 pi：
 * - 私聊：发送者在白名单内直接触发；
 * - 群聊：消息 @ 了机器人（at 段或文本形式的 @）即触发；
 * - 忽略机器人自己发的消息与系统消息。
 */
export function matchMessage(
  event: Record<string, unknown>,
  selfId: string,
  whitelist: Set<string>,
  atAliases: string[],
): TriggeredMessage | null {
  if (event.post_type !== "message") return null;

  const messageType = event.message_type as string | undefined;
  const userId = String(event.user_id ?? "");
  const segments = Array.isArray(event.message) ? (event.message as Array<{ type: string; data: Record<string, unknown> }>) : [];

  // 忽略自己发的消息（防止自触发循环）
  if (userId === selfId) return null;

  let text = "";
  let mentionedBot = false;
  const images: ImageRef[] = [];
  const files: FileRef[] = [];
  const replyIds: string[] = [];
  for (const seg of segments) {
    if (seg.type === "text") {
      text += String(seg.data?.text ?? "");
    } else if (seg.type === "at") {
      if (String(seg.data?.qq ?? "") === selfId) mentionedBot = true;
    } else if (seg.type === "image") {
      images.push({
        file: typeof seg.data?.file === "string" ? seg.data.file : undefined,
        fileId: typeof seg.data?.file_id === "string" ? seg.data.file_id : undefined,
        url: typeof seg.data?.url === "string" ? seg.data.url : undefined,
      });
    } else if (seg.type === "file") {
      // NapCat 的字段名不统一：file_name / name / file（收到消息时常用 file 放文件名）
      const nameCandidates = [seg.data?.file_name, seg.data?.name, seg.data?.file];
      const picked = nameCandidates.find((v) => typeof v === "string" && v.trim() !== "") as string | undefined;
      files.push({
        fileId: typeof seg.data?.file_id === "string" ? seg.data.file_id : undefined,
        name: picked,
        url: typeof seg.data?.url === "string" ? seg.data.url : undefined,
        size: Number(seg.data?.file_size ?? 0) || undefined,
      });
    } else if (seg.type === "reply") {
      const id = seg.data?.id;
      if (id !== undefined && id !== null && String(id) !== "") replyIds.push(String(id));
    }
  }
  text = text.trim();
  const hasContent = !!text || images.length > 0 || files.length > 0;

  if (messageType === "private") {
    if (!hasContent) return null;
    if (!whitelist.has(userId)) return null;
    return { kind: "private", userId, text, images, files, replyIds };
  }

  if (messageType === "group") {
    // at 段缺失时，兼容文本形式的 @（如 "@企鹅主任 在吗"），并把 @ 前缀从正文中去掉
    if (!mentionedBot) {
      const atRe = new RegExp(`@\\s*(?:${atAliases.map(escapeRegex).join("|")})`, "u");
      if (atRe.test(text)) {
        mentionedBot = true;
        text = text.replace(atRe, "").trim();
      }
    }
    if (!mentionedBot) return null;
    // 群聊对所有人开放：@ 即触发，text 可为空（单纯 @ 或只发图片/文件也要回应）
    const sender = (event.sender ?? {}) as { card?: string; nickname?: string; role?: string };
    return {
      kind: "group",
      userId,
      groupId: String(event.group_id ?? ""),
      text,
      senderName: sender.card || sender.nickname || userId,
      senderRole: sender.role,
      images,
      files,
      replyIds,
    };
  }

  return null; // 其他消息类型（如 discuss）不支持
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
