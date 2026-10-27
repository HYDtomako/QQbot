import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import { createServer, type Server } from "node:http";
import { planVoice, synthesizeMp3, trySendVoice, TTS_DEFAULTS, type TtsConfig } from "../src/tts.ts";
import {
  buildHttpRequest,
  buildSocks5ConnectRequest,
  decodeChunked,
  httpPostJson,
  parseHttpHead,
  parseProxyUrl,
  parseSocks5Reply,
  sendHttpRequest,
  socks5Connect,
  type HttpPost,
  type HttpPostOptions,
  type HttpPostResult,
} from "../src/socks-http.ts";

/**
 * fish.audio + SOCKS5 传输层离线自测。
 * 不联网、不碰真实密钥：HTTP 传输用注入的假函数，SOCKS5 用本机假代理 + 本机假目标服务。
 */

const FAKE_KEY = "fish-selftest-fake-key";
const FAKE_BASE = "https://api.fish.audio/";
const SPEAKABLE = "今天晚上吃什么呀";
const AUDIO = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb]);
const PROXY = "socks5://127.0.0.1:10808";

const FISH_CFG: TtsConfig = {
  enabled: true,
  provider: "fish",
  proxy: PROXY,
  apiKey: FAKE_KEY,
  baseUrl: FAKE_BASE,
  model: "s2.1-pro-free",
  voiceId: "fish-selftest-reference-id",
  probability: 1,
  maxChars: 80,
  format: "mp3",
};

interface Captured {
  calls: HttpPostOptions[];
}

function fakePost(handler: (opts: HttpPostOptions) => Promise<HttpPostResult>, captured: Captured): HttpPost {
  return async (opts) => {
    captured.calls.push(opts);
    return handler(opts);
  };
}

function assertNoSecretOrText(logs: string[], text: string): void {
  const joined = logs.join("\n");
  assert.equal(joined.includes(FAKE_KEY), false, "日志不得包含密钥");
  assert.equal(joined.includes("Authorization"), false, "日志不得包含 Authorization 头");
  assert.equal(joined.includes("Bearer"), false, "日志不得包含鉴权串");
  assert.equal(joined.includes(text), false, "日志不得包含文本全文");
}

// ────────────────────────── 纯函数：SOCKS5 ──────────────────────────

function testPureParsing(): void {
  assert.deepEqual(parseProxyUrl("socks5://127.0.0.1:10808"), { host: "127.0.0.1", port: 10808 });
  assert.deepEqual(parseProxyUrl("socks5h://localhost"), { host: "localhost", port: 1080 });
  for (const bad of ["", "   ", "http://127.0.0.1:10809", "socks5://", "127.0.0.1:10808", "://"]) {
    assert.equal(parseProxyUrl(bad), null, `非法代理地址应返回 null：${bad}`);
  }

  // CONNECT 请求：域名用 ATYP=3，IPv4 用 ATYP=1
  const domain = buildSocks5ConnectRequest("api.fish.audio", 443);
  assert.equal(domain[0], 0x05);
  assert.equal(domain[1], 0x01);
  assert.equal(domain[2], 0x00);
  assert.equal(domain[3], 0x03);
  assert.equal(domain[4], "api.fish.audio".length);
  assert.equal(domain.subarray(5, 5 + "api.fish.audio".length).toString(), "api.fish.audio");
  assert.equal(domain.readUInt16BE(5 + "api.fish.audio".length), 443);
  assert.equal(domain.length, 7 + "api.fish.audio".length);

  const ipv4 = buildSocks5ConnectRequest("10.1.2.3", 1080);
  assert.deepEqual([...ipv4], [5, 1, 0, 1, 10, 1, 2, 3, 0x04, 0x38]);
  assert.throws(() => buildSocks5ConnectRequest("", 443));
  assert.throws(() => buildSocks5ConnectRequest("example.com", 0));

  // 应答解析：IPv4 成功
  const okIpv4 = parseSocks5Reply(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0x1f, 0x90]));
  assert.deepEqual(okIpv4, { ok: true, host: "127.0.0.1", port: 8080, bytes: 10 });

  // 应答解析：域名成功
  const name = Buffer.from("proxy.test", "utf8");
  const okDomain = parseSocks5Reply(Buffer.concat([
    Buffer.from([5, 0, 0, 3, name.length]),
    name,
    Buffer.from([0x01, 0xbb]),
  ]));
  assert.deepEqual(okDomain, { ok: true, host: "proxy.test", port: 443, bytes: 5 + name.length + 2 });

  // 应答解析：REP≠0 失败
  const refused = parseSocks5Reply(Buffer.from([5, 0x05, 0, 1, 0, 0, 0, 0, 0, 0]));
  assert.deepEqual(refused, { ok: false, code: "rejected", rep: 5 });
  const notAllowed = parseSocks5Reply(Buffer.from([5, 0x02, 0, 1]));
  assert.deepEqual(notAllowed, { ok: false, code: "rejected", rep: 2 });

  // 不足 / 版本错
  assert.deepEqual(parseSocks5Reply(Buffer.from([5, 0])), { ok: false, code: "incomplete" });
  assert.deepEqual(parseSocks5Reply(Buffer.from([5, 0, 0, 1, 1, 2])), { ok: false, code: "incomplete" });
  assert.deepEqual(parseSocks5Reply(Buffer.from([4, 0, 0, 1])), { ok: false, code: "bad-version" });
  assert.deepEqual(parseSocks5Reply(Buffer.from([5, 0, 0, 9])), { ok: false, code: "unsupported-atyp" });
  console.log("PASS socks-pure: 代理地址/ CONNECT 请求 / 应答解析（成功、REP≠0、不足、版本错）");
}

// ────────────────────────── 纯函数：HTTP ──────────────────────────

function testHttpParsing(): void {
  const body = "hello-body";
  const request = buildHttpRequest({
    host: "api.fish.audio",
    path: "/v1/tts",
    headers: { Authorization: "Bearer x", "Content-Type": "application/json" },
    body,
  }).toString("latin1");
  assert.match(request, /^POST \/v1\/tts HTTP\/1\.1\r\n/);
  assert.match(request, /\r\nhost: api\.fish\.audio\r\n/);
  assert.match(request, /\r\ncontent-length: 10\r\n/);
  assert.match(request, /\r\nconnection: close\r\n/);
  assert.match(request, /\r\nauthorization: Bearer x\r\n/);
  assert.ok(request.endsWith(`\r\n\r\n${body}`));
  assert.equal(request.match(/host:/g)?.length, 1, "host 头不应重复");

  const head = parseHttpHead(Buffer.from("HTTP/1.1 200 OK\r\ncontent-type: audio/mpeg\r\nTransfer-Encoding: chunked\r\n\r\n"));
  assert.deepEqual(head, { status: 200, headers: { "content-type": "audio/mpeg", "transfer-encoding": "chunked" } });
  assert.equal(parseHttpHead(Buffer.from("garbage\r\n\r\n")), null);

  // chunked：完整、分片、截断、带 trailer
  const chunked = Buffer.from("5\r\nhello\r\n0\r\n\r\n", "latin1");
  assert.deepEqual(decodeChunked(chunked), { state: "done", body: Buffer.from("hello") });
  assert.deepEqual(decodeChunked(chunked.subarray(0, 4)), { state: "need-more" });
  const truncated = decodeChunked(chunked.subarray(0, 4), true);
  assert.equal(truncated.state, "error", "连接结束时未收全的 chunk 必须报错");
  assert.deepEqual(
    decodeChunked(Buffer.from("2\r\nok\r\n0\r\nx-trace: 1\r\n\r\n", "latin1")),
    { state: "done", body: Buffer.from("ok") },
  );
  assert.deepEqual(decodeChunked(Buffer.from("zz\r\n", "latin1")), { state: "error", reason: "chunk 长度非法" });
  console.log("PASS http-pure: 请求拼装 / 响应头解析 / chunked 解码（完整、分片、trailer、截断）");
}

// ────────────────────────── fish 合成路径（注入传输层） ──────────────────────────

async function testFishSynth(): Promise<void> {
  const captured: Captured = { calls: [] };

  // 200 + 音频二进制 → Buffer
  const okLogs: string[] = [];
  const audio = await synthesizeMp3(FISH_CFG, SPEAKABLE, {
    httpPost: fakePost(async () => ({ status: 200, body: AUDIO }), captured),
    log: (m) => okLogs.push(m),
    timeoutMs: 1000,
  });
  assert.ok(audio && audio.equals(AUDIO), "200 音频二进制应原样返回");
  const call = captured.calls[0];
  assert.equal(call.url, "https://api.fish.audio/v1/tts", "应去掉 baseUrl 尾斜杠后拼 /v1/tts");
  assert.equal(call.proxy, PROXY);
  assert.equal(call.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(call.headers["Content-Type"], "application/json");
  // 模型只走 HTTP 头：放进 body 上游会忽略并回 402，免费额度就不生效了。
  assert.equal(call.headers.model, "s2.1-pro-free", "fish 模型名必须放在 model 请求头");
  const sentBody = JSON.parse(call.body) as Record<string, unknown>;
  assert.deepEqual(sentBody, {
    text: SPEAKABLE,
    reference_id: "fish-selftest-reference-id",
    format: "mp3",
  });
  assert.equal("model" in sentBody, false, "body 里不得出现 model 字段");
  assert.equal(okLogs.length, 0, "成功不刷日志");
  console.log("PASS fish-ok: 200 返回 Buffer，model 走请求头、body 无 model 字段");

  // cfg.model 缺省时回落到 TTS_DEFAULTS.model，且仍然只在头里
  captured.calls.length = 0;
  const noModel: TtsConfig = { ...FISH_CFG };
  delete noModel.model;
  await synthesizeMp3(noModel, SPEAKABLE, {
    httpPost: fakePost(async () => ({ status: 200, body: AUDIO }), captured),
    timeoutMs: 1000,
  });
  assert.equal(captured.calls[0].headers.model, TTS_DEFAULTS.model, "缺省 model 应回落到 TTS_DEFAULTS.model");
  assert.equal("model" in (JSON.parse(captured.calls[0].body) as Record<string, unknown>), false);

  // 自定义模型名原样进头部
  captured.calls.length = 0;
  await synthesizeMp3({ ...FISH_CFG, model: "custom-fish-model" }, SPEAKABLE, {
    httpPost: fakePost(async () => ({ status: 200, body: AUDIO }), captured),
    timeoutMs: 1000,
  });
  assert.equal(captured.calls[0].headers.model, "custom-fish-model", "cfg.model 应原样进 model 头");
  console.log("PASS fish-model: 模型名只出现在 model 请求头（缺省回落 / 自定义原样）");

  // 400 + JSON 错误体 → null
  captured.calls.length = 0;
  const errLogs: string[] = [];
  const errorBody = Buffer.from(JSON.stringify({ message: "quota exceeded", status: 402 }), "utf8");
  const rejected = await synthesizeMp3(FISH_CFG, SPEAKABLE, {
    httpPost: fakePost(async () => ({ status: 400, body: errorBody }), captured),
    log: (m) => errLogs.push(m),
    timeoutMs: 1000,
  });
  assert.equal(rejected, null, "400 必须返回 null");
  assert.equal(captured.calls.length, 1);
  assert.ok(errLogs.some((l) => l.includes("HTTP 400")), `失败日志应含状态码：${errLogs.join("|")}`);
  assertNoSecretOrText(errLogs, SPEAKABLE);
  assert.equal(errLogs.join().includes("quota"), false, "不得把上游错误体写进日志");

  // 401 / 500 也一律 null
  for (const status of [401, 403, 429, 500, 503]) {
    assert.equal(
      await synthesizeMp3(FISH_CFG, SPEAKABLE, {
        httpPost: async () => ({ status, body: AUDIO }),
        timeoutMs: 500,
      }),
      null,
      `HTTP ${status} 必须返回 null`,
    );
  }

  // 200 但空 body / JSON 错误体 → null
  assert.equal(
    await synthesizeMp3(FISH_CFG, SPEAKABLE, { httpPost: async () => ({ status: 200, body: Buffer.alloc(0) }) }),
    null,
    "空 body 返回 null",
  );
  assert.equal(
    await synthesizeMp3(FISH_CFG, SPEAKABLE, { httpPost: async () => ({ status: 200, body: errorBody }) }),
    null,
    "200 但响应是 JSON 错误体也返回 null",
  );

  // 网络异常 → null（只记错误类型）
  const netLogs: string[] = [];
  const netFail = Object.assign(new Error("connect EACCES 127.0.0.1:10808"), { code: "EACCES" });
  assert.equal(
    await synthesizeMp3(FISH_CFG, SPEAKABLE, {
      httpPost: async () => {
        throw netFail;
      },
      log: (m) => netLogs.push(m),
    }),
    null,
    "网络异常返回 null，不抛出",
  );
  assert.ok(netLogs.some((l) => l.includes("EACCES")), `应记录错误类型：${netLogs.join("|")}`);
  assertNoSecretOrText(netLogs, SPEAKABLE);
  console.log("PASS fish-fail: 非 2xx / 空响应 / JSON 错误体 / 网络异常均安静返回 null");

  // 传输层永不返回 → 超时 null
  const started = Date.now();
  const timedOut = await synthesizeMp3(FISH_CFG, SPEAKABLE, {
    httpPost: () => new Promise<HttpPostResult>(() => {}),
    timeoutMs: 80,
  });
  const elapsed = Date.now() - started;
  assert.equal(timedOut, null, "超时必须返回 null");
  assert.ok(elapsed >= 50 && elapsed < 2000, `超时应及时返回（实际 ${elapsed}ms）`);

  // 已取消 → 不发起传输
  let abortedCalls = 0;
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await synthesizeMp3(FISH_CFG, SPEAKABLE, {
      httpPost: async () => {
        abortedCalls += 1;
        return { status: 200, body: AUDIO };
      },
      signal: controller.signal,
    }),
    null,
    "已取消应返回 null",
  );
  assert.equal(abortedCalls, 0, "已取消时不得发起合成请求");

  // 传输中取消 → null
  const mid = new AbortController();
  const pending = synthesizeMp3(FISH_CFG, SPEAKABLE, {
    httpPost: (opts) => new Promise<HttpPostResult>((_resolve, reject) => {
      opts.signal?.addEventListener("abort", () => reject(new Error("已取消")), { once: true });
    }),
    signal: mid.signal,
    timeoutMs: 5000,
  });
  setTimeout(() => mid.abort(), 30);
  assert.equal(await pending, null, "传输中取消应返回 null");

  // 缺密钥 → null 且不发请求
  let keylessCalls = 0;
  assert.equal(
    await synthesizeMp3({ ...FISH_CFG, apiKey: "" }, SPEAKABLE, {
      httpPost: async () => {
        keylessCalls += 1;
        return { status: 200, body: AUDIO };
      },
    }),
    null,
  );
  assert.equal(keylessCalls, 0, "缺密钥时不得发起请求");
  console.log("PASS fish-guard: 超时 / 已取消 / 缺密钥都返回 null 且不发出请求");

  // 缺省 provider（老配置）仍走 MiniMax，且不会碰 fish 传输层
  let minimaxUrl = "";
  let minimaxCalls = 0;
  const legacy: TtsConfig = { ...FISH_CFG, provider: undefined };
  const legacyAudio = await synthesizeMp3(legacy, SPEAKABLE, {
    fetchImpl: async (url) => {
      minimaxUrl = url;
      return { ok: true, status: 200, json: async () => ({ base_resp: { status_code: 0 }, data: { audio: AUDIO.toString("hex") } }) };
    },
    httpPost: async () => {
      minimaxCalls += 1;
      return { status: 200, body: AUDIO };
    },
  });
  assert.equal(minimaxUrl, "https://api.fish.audio/v1/t2a_v2", "缺省 provider 仍是 MiniMax 路径");
  assert.ok(legacyAudio && legacyAudio.equals(AUDIO));
  assert.equal(minimaxCalls, 0, "minimax 路径不得触发 fish 传输");
  assert.equal(TTS_DEFAULTS.provider, "minimax");
  assert.equal(TTS_DEFAULTS.proxy, "");
  console.log("PASS legacy: provider 缺省仍走 MiniMax，TTS_DEFAULTS 为 minimax + 空代理");

  // 完整流程：fish + trySendVoice（语音钩子对外行为不变）
  const flowCaptured: Captured = { calls: [] };
  const sends: Buffer[] = [];
  const flowLogs: string[] = [];
  const flow = await trySendVoice({
    cfg: FISH_CFG,
    groupId: "123456",
    isEntertainmentGroup: true,
    text: SPEAKABLE,
    deps: {
      httpPost: fakePost(async () => ({ status: 200, body: AUDIO }), flowCaptured),
      random: () => 0,
      log: (m) => flowLogs.push(m),
      sendRecord: async (_gid, mp3) => {
        sends.push(mp3);
        return true;
      },
    },
  });
  assert.equal(flow.sent, true);
  assert.equal(flowCaptured.calls.length, 1);
  assert.equal(sends.length, 1);
  assert.ok(sends[0].equals(AUDIO));
  assert.ok(flowLogs.some((l) => l.includes("已发送语音")));
  assertNoSecretOrText(flowLogs, SPEAKABLE);
  assert.equal(planVoice({ cfg: FISH_CFG, isEntertainmentGroup: true, text: SPEAKABLE, random: () => 0 }).speak, true);

  const fallbackLogs: string[] = [];
  const fallback = await trySendVoice({
    cfg: FISH_CFG,
    groupId: "123456",
    isEntertainmentGroup: true,
    text: SPEAKABLE,
    deps: {
      httpPost: async () => ({ status: 500, body: Buffer.alloc(0) }),
      random: () => 0,
      log: (m) => fallbackLogs.push(m),
      sendRecord: async () => {
        throw new Error("不应发送");
      },
    },
  });
  assert.equal(fallback.sent, false);
  assert.equal(fallback.reason, "合成失败");
  assert.ok(fallbackLogs.some((l) => l.includes("回退文字")));
  assertNoSecretOrText(fallbackLogs, SPEAKABLE);
  console.log("PASS flow: trySendVoice 在 fish 下成功发语音、失败回退文字，日志无密钥与文本");
}

// ────────────────────────── 假 SOCKS5 代理（本机回环） ──────────────────────────

interface FakeSocks {
  port: number;
  requests: Array<{ host: string; port: number; atyp: number }>;
  close(): Promise<void>;
}

function socksRequestLength(buf: Buffer): number | null {
  if (buf.length < 4) return null;
  if (buf[3] === 0x01) return 10;
  if (buf[3] === 0x03) return buf.length < 5 ? null : 7 + buf[4];
  return null;
}

/** rep=0 时真的连上游并双向转发；rep≠0 时直接拒绝。 */
async function startFakeSocks(rep = 0): Promise<FakeSocks> {
  const requests: FakeSocks["requests"] = [];
  const server = net.createServer((client) => {
    let buf = Buffer.alloc(0);
    let pending = Buffer.alloc(0);
    let piped = false;
    let stage: "greeting" | "request" | "piping" = "greeting";
    client.on("error", () => {});
    client.on("data", (chunk: Buffer) => {
      if (stage === "piping") {
        // 上游还没连上时先把字节攒起来，别把 ClientHello/请求头丢掉
        if (!piped) pending = Buffer.concat([pending, chunk]);
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greeting") {
        if (buf.length < 3) return;
        assert.deepEqual([...buf.subarray(0, 3)], [0x05, 0x01, 0x00], "客户端必须发无认证握手");
        buf = buf.subarray(3);
        client.write(Buffer.from([0x05, 0x00]));
        stage = "request";
      }
      if (stage !== "request") return;
      const need = socksRequestLength(buf);
      if (need === null || buf.length < need) return;
      const atyp = buf[3];
      let host: string;
      let port: number;
      if (atyp === 0x01) {
        host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
        port = buf.readUInt16BE(8);
      } else {
        const len = buf[4];
        host = buf.subarray(5, 5 + len).toString("utf8");
        port = buf.readUInt16BE(5 + len);
      }
      const leftover = buf.subarray(need);
      buf = Buffer.alloc(0);
      pending = Buffer.from(leftover);
      requests.push({ host, port, atyp });
      if (rep !== 0) {
        client.end(Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return;
      }
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x00]));
      stage = "piping";
      const upstream = net.connect({ host, port }, () => {
        piped = true;
        if (pending.length) upstream.write(pending);
        pending = Buffer.alloc(0);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      return;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  return {
    port: addr.port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 假目标服务：/chunked 用 chunked 编码，/fixed 用 content-length。 */
async function startTargetServer(): Promise<{ port: number; seen: Array<{ url: string; auth: string; body: string }>; close(): Promise<void> }> {
  const seen: Array<{ url: string; auth: string; body: string }> = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += String(c);
    });
    req.on("end", () => {
      seen.push({ url: req.url ?? "", auth: String(req.headers.authorization ?? ""), body });
      const payload = JSON.stringify({ ok: true, bytes: body.length });
      if ((req.url ?? "").startsWith("/chunked")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.write(payload.slice(0, 5));
        res.end(payload.slice(5));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  return { port: addr.port, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function testSocksLive(): Promise<void> {
  const target = await startTargetServer();
  try {
    // ── 直接测 socks5Connect：域名 ATYP + 隧道可用 ──
    {
      const socks = await startFakeSocks();
      try {
        const socket = await socks5Connect(
          { host: "127.0.0.1", port: socks.port },
          { host: "127.0.0.1", port: target.port },
          { timeoutMs: 3000 },
        );
        assert.deepEqual(socks.requests, [{ host: "127.0.0.1", port: target.port, atyp: 0x01 }]);
        const response = await sendHttpRequest(socket, {
          host: `127.0.0.1:${target.port}`,
          path: "/fixed",
          headers: { "Content-Type": "application/json" },
          body: "ping",
        }, { timeoutMs: 3000 });
        socket.destroy();
        assert.equal(response.status, 200);
        assert.deepEqual(JSON.parse(response.body.toString("utf8")), { ok: true, bytes: 4 });
        console.log("PASS socks-live: 假代理 CONNECT 成功，隧道里完成一次 HTTP 往返");
      } finally {
        await socks.close();
      }
    }

    // ── REP≠0：拒绝并抛出（由 tts 收敛成 null） ──
    {
      const socks = await startFakeSocks(0x05);
      try {
        await assert.rejects(
          () => socks5Connect({ host: "127.0.0.1", port: socks.port }, { host: "api.fish.audio", port: 443 }, { timeoutMs: 3000 }),
          /REQ=5/,
          "REP≠0 应拒绝连接",
        );
        console.log("PASS socks-deny: REP=5 被识别为拒绝，不会误用隧道");
      } finally {
        await socks.close();
      }
    }

    // ── 代理不回应：超时 ──
    {
      const silent = net.createServer((socket) => socket.on("data", () => {}));
      await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
      const addr = silent.address();
      assert.ok(addr && typeof addr === "object");
      try {
        await assert.rejects(
          () => socks5Connect({ host: "127.0.0.1", port: addr.port }, { host: "api.fish.audio", port: 443 }, { timeoutMs: 100 }),
          /超时/,
        );
        console.log("PASS socks-timeout: 代理不回应时按超时失败");
      } finally {
        await new Promise<void>((resolve) => silent.close(() => resolve()));
      }
    }

    // ── 完整 httpPostJson：socks5 代理 + chunked 响应 ──
    {
      const socks = await startFakeSocks();
      try {
        const result = await httpPostJson({
          url: `http://127.0.0.1:${target.port}/chunked/v1/tts`,
          headers: { Authorization: `Bearer ${FAKE_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text: SPEAKABLE }),
          proxy: `socks5://127.0.0.1:${socks.port}`,
          timeoutMs: 3000,
        });
        assert.equal(result.status, 200);
        assert.deepEqual(JSON.parse(result.body.toString("utf8")), { ok: true, bytes: JSON.stringify({ text: SPEAKABLE }).length });
        assert.equal(target.seen.at(-1)?.url, "/chunked/v1/tts");
        assert.equal(target.seen.at(-1)?.auth, `Bearer ${FAKE_KEY}`, "Authorization 头应穿过隧道原样到达");
        assert.deepEqual(JSON.parse(target.seen.at(-1)?.body ?? ""), { text: SPEAKABLE });
        console.log("PASS socks-post: httpPostJson 经 SOCKS5 完成 POST，chunked 响应被正确解码");
      } finally {
        await socks.close();
      }
    }

    // ── 凭 proxy 无法解析时退回直连（这里用桩 fetch 保证不联网） ──
    {
      const realFetch = globalThis.fetch;
      let directUrl = "";
      globalThis.fetch = (async (url: string) => {
        directUrl = String(url);
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => AUDIO.buffer.slice(AUDIO.byteOffset, AUDIO.byteOffset + AUDIO.length),
        };
      }) as unknown as typeof fetch;
      try {
        const result = await httpPostJson({
          url: "https://direct.invalid/v1/tts",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          proxy: "",
          timeoutMs: 1000,
        });
        assert.equal(directUrl, "https://direct.invalid/v1/tts");
        assert.equal(result.status, 200);
        assert.ok(result.body.equals(AUDIO));
        console.log("PASS direct: proxy 为空时退回直连（fetch），不走 SOCKS5");
      } finally {
        globalThis.fetch = realFetch;
      }
    }
  } finally {
    await target.close();
  }
}

async function testTlsThroughSocks(): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { createServer: createHttpsServer } = await import("node:https");

  const dir = mkdtempSync(path.join(tmpdir(), "tts-fish-tls-"));
  let cert: Buffer;
  let key: Buffer;
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", "key.pem", "-out", "cert.pem", "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    ], { cwd: dir, stdio: "ignore" });
    cert = readFileSync(path.join(dir, "cert.pem"));
    key = readFileSync(path.join(dir, "key.pem"));
  } catch {
    console.log("SKIP tls-socks: 本机没有 openssl，跳过 TLS 隧道测试（不影响其余用例）");
    rmSync(dir, { recursive: true, force: true });
    return;
  }

  const server = createHttpsServer({ cert, key }, (req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += String(c);
    });
    req.on("end", () => {
      // 音频二进制 + 无 content-length → chunked
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end(body ? AUDIO : Buffer.alloc(0));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const socks = await startFakeSocks();
  try {
    const result = await httpPostJson({
      url: `https://localhost:${addr.port}/v1/tts`,
      headers: { Authorization: `Bearer ${FAKE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: SPEAKABLE }),
      proxy: `socks5://127.0.0.1:${socks.port}`,
      ca: cert,
      timeoutMs: 5000,
    });
    assert.equal(result.status, 200);
    assert.ok(result.body.equals(AUDIO), "TLS 隧道里的音频字节应原样返回");
    assert.deepEqual(socks.requests, [{ host: "localhost", port: addr.port, atyp: 0x03 }], "SNI/域名应原样交给代理");
    console.log("PASS tls-socks: SOCKS5 隧道 + TLS（自签 CA）+ chunked 音频响应端到端可用");
  } finally {
    await socks.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

// ────────────────────────── 真实调用（可跳过） ──────────────────────────

const CONFIG_URL = new URL("../config.json", import.meta.url);

/** 从项目根 config.json 的 entertainment.tts 取真实配置；只读，不打印任何密钥。 */
function realFishConfig(): TtsConfig | null {
  try {
    const raw = readFileSync(CONFIG_URL, "utf8");
    const tts = (JSON.parse(raw) as { entertainment?: { tts?: TtsConfig } }).entertainment?.tts;
    if (!tts || tts.provider !== "fish" || !tts.apiKey || !tts.baseUrl) return null;
    return tts;
  } catch {
    return null;
  }
}

/**
 * 真打一次 api.fish.audio：验证 model 头能让请求从 402 变成 200。
 * 网络/代理不可用时跳过并说明，不算失败；能连上但状态或帧头不对才算失败。
 * 只打印状态码、字节数和模型名，绝不打印 apiKey。
 */
async function testRealFishCall(): Promise<void> {
  const cfg = realFishConfig();
  if (!cfg) {
    console.log("SKIP real-fish: config.json 未提供 fish 的 apiKey/baseUrl，跳过真实调用");
    return;
  }

  let status = 0;
  let modelHeader = "";
  let bodyHasModel: boolean | null = null;
  let audio: Buffer | null = null;
  try {
    audio = await synthesizeMp3(cfg, SPEAKABLE, {
      httpPost: async (opts) => {
        modelHeader = String(opts.headers.model ?? "");
        bodyHasModel = Object.prototype.hasOwnProperty.call(JSON.parse(opts.body) as object, "model");
        const res = await httpPostJson(opts);
        status = res.status;
        return res;
      },
      timeoutMs: 20000,
    });
  } catch {
    console.log("SKIP real-fish: 真实调用异常（代理或网络不可用），不视为失败");
    return;
  }

  if (status === 0) {
    console.log("SKIP real-fish: 没能连上 api.fish.audio（代理或网络不可用），不视为失败");
    return;
  }
  assert.equal(status, 200, `真实调用应返回 200（实际 ${status}）`);
  assert.ok(audio, "200 时应拿到音频字节");
  const expectedModel = cfg.model ?? TTS_DEFAULTS.model;
  assert.equal(modelHeader, expectedModel, "真实请求必须带 model 头");
  assert.equal(bodyHasModel, false, "真实请求 body 不得带 model 字段");
  const b0 = audio[0];
  const b1 = audio[1];
  assert.ok(
    (b0 === 0xff && b1 === 0xfb) || (b0 === 0xff && b1 === 0xf3),
    `音频帧头应为 0xFFFB/0xFFF3（实际 0x${b0.toString(16)}${b1.toString(16)}）`,
  );
  console.log(
    `PASS real-fish: HTTP ${status}，${audio.length} 字节，model 头 ${modelHeader}，帧头 0x${b0.toString(16)}${b1.toString(16)}`,
  );
}

async function main(): Promise<void> {
  testPureParsing();
  testHttpParsing();
  await testFishSynth();
  await testSocksLive();
  await testTlsThroughSocks();
  await testRealFishCall();
  console.log("tts-fish-selftest: all passed（离线用例不联网、不用真实密钥；SOCKS5 用本机假代理）");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
