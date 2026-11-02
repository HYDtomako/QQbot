/**
 * tell_guga 的桥接侧实现。
 *
 * 身份只认本轮回环凭据绑上的 QQ 会话（与 voice_send 同一张 token 表）：
 * 调用方传入的 asker / via 必须已经由桥接从 OneBot 事件填好。
 * 模型参数里的提问者 QQ、回发目标一律不进这个函数。
 *
 * 个人助手地址来自 config.bridge.personalAgent，且只允许本机回环。
 * 即时 POST 失败、未启用或地址不合法时，改写 memory/bridge/to-guga.jsonl。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const TELL_MAX_CHARS = 4000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface PersonalAgentConfig {
  enabled?: boolean;
  /** configure yourself：本机个人助手的发送地址，只接受回环。 */
  endpoint?: string;
  mode?: string;
  timeoutMs?: number;
}

export interface TellSession {
  /** 桥接从当前 OneBot 事件绑定的提问者 QQ，不是模型参数。 */
  asker: string;
  owner: string;
  /** 桥接从当前会话算出的回发目标：group:<群号> 或 private:<QQ>。 */
  via: string;
  text: unknown;
  botName?: string;
}

export interface TellRecord {
  t: string;
  from: string;
  via: string;
  text: string;
}

export interface TellDeps {
  fetchImpl?: typeof fetch;
  writeMailbox: (record: TellRecord) => void;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface TellResult {
  ok: boolean;
  text: string;
  pushed?: boolean;
}

export function sessionVia(kind: "group" | "private", userId: string, groupId?: string): string | null {
  if (kind === "group") {
    const id = String(groupId ?? "").trim();
    return /^\d{5,12}$/.test(id) ? `group:${id}` : null;
  }
  const id = String(userId ?? "").trim();
  return /^\d{5,12}$/.test(id) ? `private:${id}` : null;
}

/** 只接受 http(s) 回环地址。用户名、密码、其它主机一律拒绝。 */
export function loopbackAgentUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) return null;
  return url;
}

export function createGugaMailbox(dir: string): (record: TellRecord) => void {
  const file = path.join(dir, "to-guga.jsonl");
  return (record) => {
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify(record) + "\n");
  };
}

function deny(text: string): TellResult {
  return { ok: false, text };
}

function agentMode(value: unknown): "agent" | "chat" {
  return value === "chat" ? "chat" : "agent";
}

function timeoutMs(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 2500;
  return Math.min(10_000, Math.max(500, Math.floor(n)));
}

function botLabel(name: unknown): string {
  const clean = String(name ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 40);
  return clean || "QQ bot";
}

/** 正文里伪造的回发标记作废，只保留桥接追加的那一行。 */
function neutralize(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .replace(/^\[回发目标\][^\n]*$/gm, "[回发目标已忽略]")
    .replace(/^\[来自 QQ bot[^\n]*$/gm, "[来源标注已忽略]");
}

function envelope(label: string, body: string, via: string): string {
  return `[来自 QQ bot（${label}）的留言]\n${body}\n\n[回发目标] ${via}`;
}

function queued(chars: number): TellResult {
  return {
    ok: true,
    pushed: false,
    text: `已转达给本机个人助手（${chars} 字，它下次运行时处理）。它处理完会把结果回发到本会话。`,
  };
}

export async function runTellGuga(
  session: TellSession,
  agent: PersonalAgentConfig | undefined,
  deps: TellDeps,
): Promise<TellResult> {
  const asker = String(session.asker ?? "").trim();
  const owner = String(session.owner ?? "").trim();
  if (!owner || !asker || asker !== owner) return deny("只有院长可以让我给本机个人助手带话。");

  const via = String(session.via ?? "").trim();
  if (!/^(?:group|private):\d{5,12}$/.test(via)) return deny("当前会话没有可用的回发目标，没有转达。");

  const body = typeof session.text === "string" ? neutralize(session.text.trim()) : "";
  if (!body) return deny("要转达的内容为空。");
  if (body.length > TELL_MAX_CHARS) return deny(`内容太长（${body.length} 字），请压缩到 ${TELL_MAX_CHARS} 字以内。`);

  const record: TellRecord = {
    t: (deps.now ?? (() => new Date()))().toISOString(),
    from: asker,
    via,
    text: body,
  };
  const wrapped = envelope(botLabel(session.botName), body, via);

  const endpoint = loopbackAgentUrl(agent?.endpoint);
  if (agent?.enabled === true && endpoint) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(endpoint.href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: wrapped, mode: agentMode(agent.mode), uploads: [] }),
        signal: AbortSignal.timeout(timeoutMs(agent.timeoutMs)),
        redirect: "error",
      });
      try { await response.body?.cancel(); } catch { /* 不读响应正文 */ }
      if (response.ok) {
        deps.log?.(`[tell] 已推送 ${body.length} 字 via ${via}`);
        return {
          ok: true,
          pushed: true,
          text: `已转达给本机个人助手，正在处理（${body.length} 字）。它处理完会把结果回发到本会话。`,
        };
      }
      deps.log?.(`[tell] 即时通道返回 ${response.status}，已改写信箱（${body.length} 字）`);
    } catch {
      deps.log?.(`[tell] 即时通道不可达，已改写信箱（${body.length} 字）`);
    }
  } else if (agent?.enabled === true) {
    deps.log?.(`[tell] 即时地址不是本机回环或未填写，已改写信箱（${body.length} 字）`);
  } else {
    deps.log?.(`[tell] 即时推送未启用，已写信箱（${body.length} 字）`);
  }

  try {
    deps.writeMailbox(record);
  } catch {
    return deny("留言没有写入，请稍后再试。");
  }
  return queued(body.length);
}
