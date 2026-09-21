/**
 * 反刷屏（群管）：同一群内相同文本在时间窗内出现 ≥ minRepeats 次（含首条）时，
 * 保留最先发出的一条，其余自动撤回，并输出提示。
 *
 * 平台限制：QQ 管理员只能撤回普通成员的消息；对管理员/群主的消息撤回会失败，
 * 这里如实记录失败数量。豁免用户（默认院长）的消息参与计数但不会被撤回。
 * 纯机械判定，不经过 LLM，零 token 开销。
 */

export interface AntispamConfig {
  enabled?: boolean;
  windowMs?: number; // 判定时间窗（默认 90 秒）
  minRepeats?: number; // 同文本出现多少次触发（含首条，默认 3）
  noticeText?: string;
  noticeCooldownMs?: number; // 同一刷屏内容提示的冷却时间
  exemptUsers?: string[]; // 消息不被撤回的用户（计数仍参与）
}

export interface AntispamClient {
  deleteMsg(messageId: number): Promise<{ retcode: number }>;
  sendGroupText(groupId: string, text: string): Promise<unknown>;
}

interface Rec {
  userId: string;
  messageId: number;
  text: string;
  time: number;
  recalled?: boolean;
}

const DEFAULT = {
  windowMs: 90_000,
  minRepeats: 3,
  noticeText: "本群禁止刷屏行为",
  noticeCooldownMs: 120_000,
};

export class Antispam {
  private readonly cfg: AntispamConfig;
  private readonly client: AntispamClient;
  private log = new Map<string, Rec[]>();
  private noticed = new Map<string, number>();

  constructor(cfg: AntispamConfig, client: AntispamClient) {
    this.cfg = cfg;
    this.client = client;
  }

  async checkGroupMessage(event: {
    group_id?: unknown;
    user_id?: unknown;
    message_id?: unknown;
    message?: unknown;
  }): Promise<void> {
    if (this.cfg.enabled === false) return;
    const groupId = String(event.group_id ?? "");
    const userId = String(event.user_id ?? "");
    if (!groupId || !userId) return;

    // 只对纯文本消息判定（含图片等非文本段的不参与）
    const segs = Array.isArray(event.message)
      ? (event.message as Array<{ type: string; data?: Record<string, unknown> }>)
      : [];
    let text = "";
    for (const s of segs) {
      if (s.type === "text") text += String(s.data?.text ?? "");
      else if (s.type !== "at") return;
    }
    const norm = text.replace(/\s+/g, " ").trim();
    if (!norm) return;

    const now = Date.now();
    const windowMs = this.cfg.windowMs ?? DEFAULT.windowMs;
    const minRepeats = this.cfg.minRepeats ?? DEFAULT.minRepeats;
    const exempt = new Set(this.cfg.exemptUsers ?? []);

    // 清理过期的提示冷却记录，避免长期运行后无限累积
    if (this.noticed.size > 200) {
      const stale = now - (this.cfg.noticeCooldownMs ?? DEFAULT.noticeCooldownMs) * 2;
      for (const [k, v] of this.noticed) if (v < stale) this.noticed.delete(k);
    }

    const list = (this.log.get(groupId) ?? []).filter((r) => now - r.time <= windowMs);
    const rec: Rec = { userId, messageId: Number(event.message_id ?? 0), text: norm, time: now };
    list.push(rec);

    const same = list.filter((r) => r.text === norm);
    if (same.length >= minRepeats && rec.messageId) {
      const first = same[0]; // 只保留最先发言的
      const victims = same.filter((r) => r !== first && !r.recalled && !exempt.has(r.userId));
      let recalled = 0;
      let failed = 0;
      for (const v of victims) {
        try {
          const res = await this.client.deleteMsg(v.messageId);
          if (res.retcode === 0) {
            v.recalled = true;
            recalled++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }
      if (recalled > 0) {
        const key = `${groupId}|${norm}`;
        const last = this.noticed.get(key) ?? 0;
        if (now - last >= (this.cfg.noticeCooldownMs ?? DEFAULT.noticeCooldownMs)) {
          this.noticed.set(key, now);
          await this.client.sendGroupText(groupId, this.cfg.noticeText ?? DEFAULT.noticeText);
        }
      }
      if (failed > 0) {
        console.log(
          `[antispam] 群 ${groupId}：${failed} 条消息无法撤回（对方是管理员/群主时 QQ 平台不允许管理员撤回）`,
        );
      }
    }
    this.log.set(groupId, list);
  }
}
