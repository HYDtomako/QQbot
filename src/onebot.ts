import WebSocket from "ws";

export type MessageSegment = { type: string; data: Record<string, unknown> };

export interface OneBotApiResult {
  status: string;
  retcode: number;
  data?: unknown;
  echo?: string;
}

type MessageEvent = Record<string, unknown>;

/**
 * OneBot 11 正向 WebSocket 客户端：事件上报与 API 调用走同一条连接。
 */
export class OneBotClient {
  private readonly url: string;
  private readonly token: string;
  private ws: WebSocket | null = null;
  private echoSeq = 0;
  private pending = new Map<string, { resolve: (v: OneBotApiResult) => void; reject: (e: Error) => void }>();
  private handlers: Array<(event: MessageEvent) => void> = [];
  private disconnectWaiters: Array<() => void> = [];

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.token ? `${this.url}?access_token=${encodeURIComponent(this.token)}` : this.url;
      const ws = new WebSocket(url, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined });
      this.ws = ws;

      ws.on("open", () => resolve());
      ws.on("error", (err) => {
        this.rejectAll(err);
        reject(err);
      });
      ws.on("close", (code) => {
        const err = new Error(`OneBot 连接关闭 (code=${code})`);
        this.rejectAll(err);
        for (const w of this.disconnectWaiters.splice(0)) {
          try {
            w();
          } catch {
            /* waiter 异常不中断 */
          }
        }
        for (const h of this.handlers) {
          try {
            h({ type: "disconnected", code });
          } catch {
            /* handler 异常不中断 */
          }
        }
      });
      ws.on("message", (raw) => {
        let data: MessageEvent;
        try {
          data = JSON.parse(String(raw));
        } catch {
          return; // 非 JSON 帧，忽略
        }
        if (typeof data.echo === "string" && this.pending.has(data.echo)) {
          const p = this.pending.get(data.echo)!;
          this.pending.delete(data.echo);
          p.resolve(data as unknown as OneBotApiResult);
          return;
        }
        for (const h of this.handlers) {
          try {
            h(data);
          } catch (err) {
            console.error("[onebot] handler 异常:", err);
          }
        }
      });
    });
  }

  onEvent(handler: (event: MessageEvent) => void): void {
    this.handlers.push(handler);
  }

  /** 等待当前连接断开（若已断开则立即返回）。供单一重连循环使用。 */
  waitDisconnected(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve();
        return;
      }
      this.disconnectWaiters.push(resolve);
    });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private call(action: string, params: Record<string, unknown>): Promise<OneBotApiResult> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("OneBot 未连接"));
    }
    const echo = `bot-${++this.echoSeq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(echo, { resolve, reject });
      ws.send(JSON.stringify({ action, params, echo }), (err) => {
        if (err) {
          this.pending.delete(echo);
          reject(err);
        }
      });
      // 兜底：30s 无响应视为失败
      setTimeout(() => {
        if (this.pending.has(echo)) {
          this.pending.delete(echo);
          reject(new Error(`API ${action} 响应超时`));
        }
      }, 30_000).unref();
    });
  }

  async sendMessage(params: {
    message_type: "private" | "group";
    user_id?: string | number;
    group_id?: string | number;
    message: MessageSegment[];
  }): Promise<OneBotApiResult> {
    return this.call("send_msg", params as unknown as Record<string, unknown>);
  }

  /** 查询群名，失败返回 null。 */
  async getGroupName(groupId: string): Promise<string | null> {
    try {
      const res = await this.call("get_group_info", { group_id: groupId });
      const data = res.data as { group_name?: string } | undefined;
      return data?.group_name ?? null;
    } catch {
      return null;
    }
  }

  async getGroupList(): Promise<Array<{ group_id: number; group_name: string }>> {
    const res = await this.call("get_group_list", {});
    return (res.data as Array<{ group_id: number; group_name: string }>) ?? [];
  }

  async getGroupMemberList(groupId: string): Promise<Array<Record<string, unknown>>> {
    const res = await this.call("get_group_member_list", { group_id: Number(groupId) });
    return (res.data as Array<Record<string, unknown>>) ?? [];
  }

  /** 撤回消息（需要 bot 有相应群权限）。 */
  async deleteMsg(messageId: number): Promise<OneBotApiResult> {
    return this.call("delete_msg", { message_id: messageId });
  }

  /** 取图片：返回本地路径或 base64 数据（NapCat get_image 接口）。 */
  async getImage(file: string): Promise<{ path?: string; base64?: string } | null> {
    try {
      const res = await this.call("get_image", { file });
      const data = res.data as { file?: string } | undefined;
      const f = data?.file;
      if (typeof f !== "string" || !f) return null;
      if (f.startsWith("base64://")) return { base64: f.slice("base64://".length) };
      return { path: f };
    } catch {
      return null;
    }
  }

  /** 取历史消息详情（用于解析"引用回复"里的图片等）。 */
  async getMsg(messageId: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.call("get_msg", { message_id: Number(messageId) || messageId });
      return (res.data as Record<string, unknown>) ?? null;
    } catch {
      return null;
    }
  }

  /** 取文件：返回本地路径 / base64 / 下载链接（NapCat get_file 接口）。 */
  async getFile(fileId: string): Promise<{ path?: string; base64?: string; url?: string } | null> {
    try {
      const res = await this.call("get_file", { file_id: fileId });
      const data = res.data as { file?: string; url?: string } | undefined;
      const f = data?.file;
      if (typeof f === "string" && f) {
        if (f.startsWith("base64://")) return { base64: f.slice("base64://".length) };
        if (/^https?:\/\//i.test(f)) return { url: f };
        return { path: f };
      }
      if (typeof data?.url === "string" && data.url) return { url: data.url };
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 发送合并转发（聊天记录卡片），返回 forward_id；失败返回 null（调用方回退为普通文本）。
   */
  async sendForward(
    target: { kind: "group"; groupId: string } | { kind: "private"; userId: string },
    nodes: Array<{ userId: string; nickname: string; content: string }>,
  ): Promise<string | null> {
    try {
      const res = await this.call("send_forward_msg", {
        messages: nodes.map((n) => ({ type: "node", data: { user_id: n.userId, nickname: n.nickname, content: n.content } })),
        ...(target.kind === "group" ? { group_id: target.groupId } : { user_id: target.userId }),
      });
      if (res.retcode !== 0) return null;
      const data = res.data as { forward_id?: string } | undefined;
      return data?.forward_id ?? null;
    } catch {
      return null;
    }
  }

  close(): void {
    this.ws?.close();
    this.rejectAll(new Error("连接已关闭"));
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}
