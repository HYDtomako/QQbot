/**
 * 极简 SOCKS5 → TLS → HTTP/1.1 POST 客户端。
 *
 * 只为一件需求存在：本机只能走 socks5://127.0.0.1:10808 出网时，
 * 给 api.fish.audio 发一个 JSON POST 并拿回音频字节。
 * 所有失败都通过抛异常表达，由调用方（tts.ts）收敛成 null；
 * 这里不记录任何请求体、文本内容或鉴权头。
 */

import net from "node:net";
import tls from "node:tls";
import { URL } from "node:url";

const SOCKS5_VERSION = 0x05;
const SOCKS5_METHOD_NO_AUTH = 0x00;
const SOCKS5_CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;

/** socks5 无认证握手：[VER=5, NMETHODS=1, METHOD=0]。 */
export const SOCKS5_GREETING = Buffer.from([SOCKS5_VERSION, 1, SOCKS5_METHOD_NO_AUTH]);

export interface Socks5Endpoint {
  host: string;
  port: number;
}

export interface HttpPostOptions {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** 形如 socks5://127.0.0.1:10808；空串或无法解析时走直连。 */
  proxy?: string;
  /** 自定义 CA（自测用本机自签证书时使用），缺省用系统信任链。 */
  ca?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpPostResult {
  status: number;
  body: Buffer;
}

/** 可注入的传输层，便于离线自测。 */
export type HttpPost = (opts: HttpPostOptions) => Promise<HttpPostResult>;

export type Socks5Reply =
  | { ok: true; host: string; port: number; bytes: number }
  | { ok: false; code: "incomplete" | "bad-version" | "rejected" | "unsupported-atyp"; rep?: number };

/** 解析 socks5://host:port（兼容 socks5h://），非法返回 null。 */
export function parseProxyUrl(raw: string | null | undefined): Socks5Endpoint | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "socks5:" && protocol !== "socks5h:") return null;
  const port = Number(url.port || 1080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) return null;
  return { host, port };
}

/** 构造 CONNECT 请求：域名走 ATYP=0x03，IPv4 走 ATYP=0x01。 */
export function buildSocks5ConnectRequest(host: string, port: number): Buffer {
  const name = String(host ?? "").trim();
  if (!name) throw new Error("socks5: 目标主机为空");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("socks5: 目标端口非法");
  if (net.isIPv4(name)) {
    const buf = Buffer.alloc(10);
    buf[0] = SOCKS5_VERSION;
    buf[1] = SOCKS5_CMD_CONNECT;
    buf[2] = 0x00;
    buf[3] = ATYP_IPV4;
    for (const [i, part] of name.split(".").entries()) buf[4 + i] = Number(part);
    buf.writeUInt16BE(port, 8);
    return buf;
  }
  if (net.isIPv6(name)) throw new Error("socks5: 不支持 IPv6 目标");
  const encoded = Buffer.from(name, "utf8");
  if (!encoded.length || encoded.length > 255) throw new Error("socks5: 目标主机名长度非法");
  const buf = Buffer.alloc(7 + encoded.length);
  buf[0] = SOCKS5_VERSION;
  buf[1] = SOCKS5_CMD_CONNECT;
  buf[2] = 0x00;
  buf[3] = ATYP_DOMAIN;
  buf[4] = encoded.length;
  encoded.copy(buf, 5);
  buf.writeUInt16BE(port, 5 + encoded.length);
  return buf;
}

/**
 * 解析服务端 CONNECT 应答（VER REP RSV ATYP BND.ADDR BND.PORT）。
 * 数据不足返回 incomplete；REP≠0 返回 rejected（带 rep）；成功带回绑定地址与消费字节数。
 */
export function parseSocks5Reply(buf: Buffer): Socks5Reply {
  if (buf.length < 4) return { ok: false, code: "incomplete" };
  if (buf[0] !== SOCKS5_VERSION) return { ok: false, code: "bad-version" };
  const rep = buf[1];
  if (rep !== 0x00) return { ok: false, code: "rejected", rep };
  const atyp = buf[3];
  if (atyp === ATYP_IPV4) {
    if (buf.length < 10) return { ok: false, code: "incomplete" };
    return { ok: true, host: `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`, port: buf.readUInt16BE(8), bytes: 10 };
  }
  if (atyp === ATYP_DOMAIN) {
    if (buf.length < 5) return { ok: false, code: "incomplete" };
    const len = buf[4];
    const end = 5 + len + 2;
    if (buf.length < end) return { ok: false, code: "incomplete" };
    return { ok: true, host: buf.subarray(5, 5 + len).toString("utf8"), port: buf.readUInt16BE(5 + len), bytes: end };
  }
  return { ok: false, code: "unsupported-atyp" };
}

/**
 * 建立到 target 的 SOCKS5 隧道，成功时 socket 处于暂停状态，留给上层做 TLS/HTTP。
 */
export function socks5Connect(
  proxy: Socks5Endpoint,
  target: Socks5Endpoint,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const timeoutMs = Math.max(1, opts.timeoutMs ?? 15000);
    let request: Buffer;
    try {
      request = buildSocks5ConnectRequest(target.host, target.port);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let received = Buffer.alloc(0);
    let stage: "greeting" | "reply" = "greeting";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (received.length) socket.unshift(received);
      received = Buffer.alloc(0);
      socket.pause();
      resolve(socket);
    };
    const onError = (err: Error): void => fail(err instanceof Error ? err : new Error(String(err)));
    const onClose = (): void => fail(new Error("SOCKS5 连接被关闭"));
    const onAbort = (): void => fail(new Error("已取消"));

    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      if (stage === "greeting") {
        if (received.length < 2) return;
        if (received[0] !== SOCKS5_VERSION || received[1] !== SOCKS5_METHOD_NO_AUTH) {
          fail(new Error("SOCKS5 代理要求认证或版本不符"));
          return;
        }
        received = received.subarray(2);
        stage = "reply";
        socket.write(request);
      }
      if (stage !== "reply") return;
      const parsed = parseSocks5Reply(received);
      if (!parsed.ok) {
        if (parsed.code === "incomplete") return;
        const detail = parsed.rep !== undefined ? ` REQ=${parsed.rep}` : "";
        fail(new Error(`SOCKS5 代理拒绝连接（${parsed.code}${detail}）`));
        return;
      }
      received = received.subarray(parsed.bytes);
      succeed();
    };

    timer = setTimeout(() => fail(new Error("SOCKS5 连接超时")), timeoutMs);
    socket.on("connect", () => socket.write(SOCKS5_GREETING));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    if (opts.signal) {
      if (opts.signal.aborted) {
        fail(new Error("已取消"));
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** 在既有 socket 上做 TLS（SNI=目标主机名），成功返回已就绪的 TLSSocket。 */
export function tlsTunnel(
  socket: net.Socket,
  host: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; ca?: string | Buffer } = {},
): Promise<tls.TLSSocket> {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const timeoutMs = Math.max(1, opts.timeoutMs ?? 15000);
    const servername = net.isIP(host) ? undefined : host;
    const secure = tls.connect({
      socket,
      servername,
      ALPNProtocols: ["http/1.1"],
      ...(opts.ca !== undefined ? { ca: opts.ca } : {}),
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      secure.removeListener("error", onError);
      secure.removeListener("close", onClose);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      secure.destroy();
      reject(err);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(secure);
    };
    const onError = (err: Error): void => fail(err instanceof Error ? err : new Error(String(err)));
    const onClose = (): void => fail(new Error("TLS 连接被关闭"));
    const onAbort = (): void => fail(new Error("已取消"));

    timer = setTimeout(() => fail(new Error("TLS 握手超时")), timeoutMs);
    secure.once("secureConnect", succeed);
    secure.once("error", onError);
    secure.once("close", onClose);
    if (opts.signal) {
      if (opts.signal.aborted) {
        fail(new Error("已取消"));
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** 拼一个 HTTP/1.1 POST 请求（含 content-length，强制 connection: close）。 */
export function buildHttpRequest(req: {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string | Buffer;
}): Buffer {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""), "utf8");
  const skip = new Set(["host", "content-length", "connection"]);
  const lines = [`POST ${req.path} HTTP/1.1`, `host: ${req.host}`];
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    if (!key || skip.has(key.toLowerCase())) continue;
    lines.push(`${key.toLowerCase()}: ${String(value).replace(/[\r\n]+/g, " ")}`);
  }
  lines.push(`content-length: ${body.length}`, "connection: close", "", "");
  return Buffer.concat([Buffer.from(lines.join("\r\n"), "latin1"), body]);
}

/** 解析状态行 + 响应头；数据不足或格式不对返回 null。 */
export function parseHttpHead(head: Buffer): { status: number; headers: Record<string, string> } | null {
  const text = head.toString("latin1");
  const [statusLine, ...rest] = text.split("\r\n");
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine ?? "");
  if (!match) return null;
  const headers: Record<string, string> = {};
  for (const line of rest) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { status: Number(match[1]), headers };
}

export type ChunkedResult =
  | { state: "need-more" }
  | { state: "done"; body: Buffer }
  | { state: "error"; reason: string };

/** 增量解码 chunked 响应体；flush=true 表示连接已结束，剩余字节视为截断。 */
export function decodeChunked(input: Buffer, flush = false): ChunkedResult {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = input.indexOf("\r\n", offset);
    if (lineEnd < 0) return flush ? { state: "error", reason: "chunk 头不完整" } : { state: "need-more" };
    const sizeText = input.subarray(offset, lineEnd).toString("latin1").split(";")[0].trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) return { state: "error", reason: "chunk 长度非法" };
    const size = Number.parseInt(sizeText, 16);
    let cursor = lineEnd + 2;
    if (size === 0) {
      for (;;) {
        const trailerEnd = input.indexOf("\r\n", cursor);
        if (trailerEnd < 0) return flush ? { state: "error", reason: "chunk 尾部不完整" } : { state: "need-more" };
        if (trailerEnd === cursor) return { state: "done", body: Buffer.concat(chunks) };
        cursor = trailerEnd + 2;
      }
    }
    if (input.length < cursor + size + 2) return flush ? { state: "error", reason: "chunk 数据被截断" } : { state: "need-more" };
    chunks.push(input.subarray(cursor, cursor + size));
    cursor += size;
    if (input[cursor] !== 0x0d || input[cursor + 1] !== 0x0a) return { state: "error", reason: "chunk 结尾缺少 CRLF" };
    offset = cursor + 2;
  }
}

/**
 * 在已连通的 socket 上发一次 HTTP/1.1 POST 并读完响应体。
 * 支持 Content-Length、chunked、以及连接关闭定界三种情况。
 */
export function sendHttpRequest(
  socket: net.Socket,
  req: { host: string; path: string; headers: Record<string, string>; body: string | Buffer },
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<HttpPostResult> {
  return new Promise<HttpPostResult>((resolve, reject) => {
    const timeoutMs = Math.max(1, opts.timeoutMs ?? 15000);
    let head: { status: number; headers: Record<string, string> } | null = null;
    let raw = Buffer.alloc(0);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      socket.removeListener("data", onData);
      socket.removeListener("end", onEnd);
      socket.removeListener("close", onEnd);
      socket.removeListener("error", onError);
    };
    const finish = (err: Error | null, result?: HttpPostResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) {
        socket.destroy();
        reject(err);
        return;
      }
      resolve(result!);
    };

    const tryComplete = (flush: boolean): void => {
      if (!head || settled) return;
      const encoding = String(head.headers["transfer-encoding"] ?? "").toLowerCase();
      if (encoding.includes("chunked")) {
        const decoded = decodeChunked(raw, flush);
        if (decoded.state === "done") finish(null, { status: head.status, body: decoded.body });
        else if (decoded.state === "error") finish(new Error(`chunked 响应损坏（${decoded.reason}）`));
        else if (flush) finish(new Error("chunked 响应被截断"));
        return;
      }
      const lengthText = head.headers["content-length"];
      if (lengthText !== undefined) {
        const expected = Number.parseInt(lengthText, 10);
        if (!Number.isFinite(expected) || expected < 0) finish(new Error("content-length 非法"));
        else if (raw.length >= expected) finish(null, { status: head.status, body: raw.subarray(0, expected) });
        else if (flush) finish(new Error("响应体被截断"));
        return;
      }
      // 无长度信息：以连接关闭定界
      if (flush) finish(null, { status: head.status, body: raw });
    };

    const onData = (chunk: Buffer): void => {
      raw = Buffer.concat([raw, chunk]);
      if (!head) {
        const idx = raw.indexOf("\r\n\r\n");
        if (idx < 0) {
          if (raw.length > 64 * 1024) finish(new Error("响应头过大"));
          return;
        }
        const parsed = parseHttpHead(raw.subarray(0, idx));
        if (!parsed) {
          finish(new Error("响应头无法解析"));
          return;
        }
        head = parsed;
        raw = raw.subarray(idx + 4);
        if (head.status === 204 || head.status === 304) {
          finish(null, { status: head.status, body: Buffer.alloc(0) });
          return;
        }
      }
      tryComplete(false);
    };
    const onEnd = (): void => {
      if (settled) return;
      if (!head) {
        finish(new Error("连接在响应头之前关闭"));
        return;
      }
      tryComplete(true);
      if (!settled) finish(new Error("响应未完成连接就关闭"));
    };
    const onError = (err: Error): void => finish(err instanceof Error ? err : new Error(String(err)));
    const onAbort = (): void => finish(new Error("已取消"));

    timer = setTimeout(() => finish(new Error("HTTP 响应超时")), timeoutMs);
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onEnd);
    socket.once("error", onError);
    if (opts.signal) {
      if (opts.signal.aborted) {
        finish(new Error("已取消"));
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      socket.write(buildHttpRequest(req));
      if (socket.isPaused()) socket.resume();
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** 直连：交给全局 fetch，避免自己维护 https.request 的连接释放。 */
async function postJsonDirect(opts: HttpPostOptions): Promise<HttpPostResult> {
  const fetchImpl = globalThis.fetch as typeof fetch | undefined;
  if (typeof fetchImpl !== "function") throw new Error("当前运行时缺少 fetch");
  const timeoutMs = Math.max(1, opts.timeoutMs ?? 15000);
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timer);
      throw new Error("已取消");
    }
    opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetchImpl(opts.url, {
      method: "POST",
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: buf };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** 走 SOCKS5 隧道：握手 → TLS → HTTP POST。 */
async function postJsonViaSocks(opts: HttpPostOptions, proxy: Socks5Endpoint): Promise<HttpPostResult> {
  const url = new URL(opts.url);
  const secure = url.protocol === "https:";
  if (!secure && url.protocol !== "http:") throw new Error(`不支持的协议 ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || (secure ? 443 : 80));
  const path = `${url.pathname || "/"}${url.search || ""}`;
  const timeoutMs = Math.max(1, opts.timeoutMs ?? 15000);
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(1, deadline - Date.now());

  const raw = await socks5Connect(proxy, { host, port }, { timeoutMs: remaining(), signal: opts.signal });
  let socket: net.Socket = raw;
  try {
    if (secure) socket = await tlsTunnel(raw, host, { timeoutMs: remaining(), signal: opts.signal, ca: opts.ca });
    return await sendHttpRequest(
      socket,
      { host: url.host, path, headers: opts.headers, body: opts.body },
      { timeoutMs: remaining(), signal: opts.signal },
    );
  } finally {
    socket.destroy();
    if (raw !== socket) raw.destroy();
  }
}

/** 统一入口：有代理走 SOCKS5，没有就直连。失败抛异常，由调用方收敛。 */
export async function httpPostJson(opts: HttpPostOptions): Promise<HttpPostResult> {
  const proxy = parseProxyUrl(opts.proxy);
  if (!proxy) return postJsonDirect(opts);
  return postJsonViaSocks(opts, proxy);
}
