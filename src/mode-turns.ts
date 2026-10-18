export interface ReplyTurn {
  readonly entertainment: boolean;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  finish(): void;
  /** 模式切换由本回合发起：允许它在切换后继续把确认回复发完。 */
  allowModeChange(): void;
  /** 本回合是否已被放行跨越模式切换。 */
  modeChangeAllowed(): boolean;
}

/** 切换会永久作废旧 turn；即使模式随后切回，旧 signal 也不会恢复。 */
export class ModeTurns {
  private readonly entertainment: (groupId: string) => boolean;
  private readonly active = new Set<{ groupId?: string; controller: AbortController }>();
  private closed = false;

  constructor(entertainment: (groupId: string) => boolean) {
    this.entertainment = entertainment;
  }

  begin(groupId?: string): ReplyTurn {
    let allowedModeChange = false;
    const entry: { groupId?: string; controller: AbortController; turn?: ReplyTurn } = {
      groupId,
      controller: new AbortController(),
    };
    const entertainment = groupId !== undefined && this.entertainment(groupId);
    if (this.closed) entry.controller.abort();
    else this.active.add(entry);
    const turn: ReplyTurn = {
      entertainment,
      signal: entry.controller.signal,
      isCurrent: () => !this.closed && !entry.controller.signal.aborted
        && (allowedModeChange || groupId === undefined || entertainment === this.entertainment(groupId)),
      finish: () => { this.active.delete(entry); },
      allowModeChange: () => { allowedModeChange = true; },
      modeChangeAllowed: () => allowedModeChange,
    };
    entry.turn = turn;
    return turn;
  }

  invalidate(groupId: string, except?: ReplyTurn): void {
    for (const entry of this.active) {
      if (entry.groupId !== groupId || entry.turn === except) continue;
      this.active.delete(entry);
      entry.controller.abort("群聊模式已切换");
    }
  }

  close(): void {
    this.closed = true;
    for (const entry of this.active) entry.controller.abort("桥接正在关闭");
    this.active.clear();
  }
}

export function groupSessionKey(groupId: string, entertainment: boolean): string {
  // v2 不读取或摘要旧的混合会话；旧文件保留，不在升级时删除用户记录。
  return `mode-v2-${entertainment ? "ent" : "normal"}-group-${groupId}`;
}
