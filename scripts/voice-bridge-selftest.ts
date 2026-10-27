import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * voice_send 桥接集成自测：临时项目 + 假 OneBot（ws）+ 假 TTS（本机 http）。
 * 验证 main.ts 的 /voice-send 路由、回合身份绑定、模式/权限判定和 record 发送。
 * 不连接真实 QQ、不调用 MiniMax（baseUrl 指向本机假服务，密钥是假值）。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(root, ".voice-bridge-"));

const owner = "12345";
const stranger = "34567";
const bot = "10000";
const entGroup = "45678";
const normalGroup = "45679";
const FAKE_KEY = "voice-bridge-selftest-fake-key";
const SPOKEN = "今天下午只有高数和英语两节课";
const AUDIO = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb]);

let counter = 0;
let output = "";
let socket: WebSocket | undefined;
const sent: any[] = [];
const ttsRequests: Array<{ url?: string; auth: string; body: any }> = [];
let ttsMode: "ok" | "fail" = "ok";

const ttsServer: Server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += String(chunk); });
  req.on("end", () => {
    let parsed: any = {};
    try { parsed = JSON.parse(body); } catch { /* 记录下来即可 */ }
    ttsRequests.push({ url: req.url, auth: String(req.headers.authorization ?? ""), body: parsed });
    if (ttsMode === "fail") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: AUDIO.toString("hex") } }));
  });
});
await new Promise<void>((resolve) => ttsServer.listen(0, "127.0.0.1", resolve));
const ttsAddr = ttsServer.address();
assert.ok(ttsAddr && typeof ttsAddr === "object");

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise<void>((resolve) => server.once("listening", resolve));
const wsAddr = server.address();
assert.ok(wsAddr && typeof wsAddr !== "string");

server.on("connection", (ws) => {
  socket = ws;
  ws.on("message", (raw) => {
    const request = JSON.parse(String(raw));
    let data: any = {};
    if (request.action === "get_group_list" || request.action === "get_group_member_list") data = [];
    if (request.action === "get_group_info") data = { group_name: request.params.group_id === entGroup ? "语音测试群" : "普通测试群" };
    if (request.action.startsWith("send_")) {
      sent.push(request);
      data = { message_id: ++counter, forward_id: `fixture-${counter}` };
    }
    ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo, data }));
  });
});

function textOf(request: any): string {
  return JSON.stringify(request.params);
}
function records(): any[] {
  return sent.filter((s) => s.action === "send_group_msg"
    && Array.isArray(s.params.message)
    && s.params.message.some((seg: any) => seg.type === "record"));
}
/** 不含语音的普通群消息（文字/表情包）：语音成功后这类消息必须为零。 */
function plainMessages(): any[] {
  return sent.filter((s) => (s.action === "send_group_msg" || s.action === "send_forward_msg")
    && !(Array.isArray(s.params.message) && s.params.message.some((seg: any) => seg.type === "record")));
}
function anySent(fragment: string): boolean {
  return sent.some((s) => textOf(s).includes(fragment));
}
async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!check()) {
    if (child && child.exitCode !== null) throw new Error(`bridge exited: ${output.slice(-2000)}`);
    if (Date.now() > deadline) throw new Error(`${label} timed out: ${output.slice(-2500)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
function emit(text: string, gid: string, userId = owner): void {
  socket!.send(JSON.stringify({
    post_type: "message", message_type: "group", user_id: userId, group_id: gid,
    message_id: ++counter, time: Math.floor(Date.now() / 1000),
    sender: { nickname: userId === owner ? "院长" : "群友", role: "member" },
    message: [{ type: "at", data: { qq: bot } }, { type: "text", data: { text } }],
  }));
}

let child: ReturnType<typeof spawn> | undefined;
function writeConfig(allowOthers: boolean): void {
  writeFileSync(path.join(temp, "config.json"), JSON.stringify({
    onebot: { wsUrl: `ws://127.0.0.1:${wsAddr.port}`, token: "synthetic" },
    bot: {
      selfId: bot, nickname: "合成机器人", owner, whitelist: [owner], atAliases: ["合成机器人"],
      maxConcurrent: 2, timeoutMs: 20000, defaultGroup: entGroup,
    },
    pi: { command: process.execPath, args: [path.join(root, "scripts", "fixtures", "pi-voice-fixture.mjs")], thinking: "", models: { test: "synthetic" }, defaultModel: "test" },
    antispam: { enabled: false },
    entertainment: {
      replyFrequency: 0,
      tts: {
        enabled: true,
        apiKey: FAKE_KEY,
        baseUrl: `http://127.0.0.1:${ttsAddr.port}`,
        model: "speech-2.8-selftest",
        voiceId: "female-shaonv",
        speed: 1, vol: 1, pitch: 0,
        probability: 0, // 关掉自动钩子，只验证工具路径
        maxChars: 80,
        format: "mp3",
        allowOthers,
      },
    },
  }, null, 1));
}
async function startBridge(allowOthers: boolean): Promise<void> {
  writeConfig(allowOthers);
  child = spawn(process.execPath, [path.join(temp, "src", "main.ts")], { cwd: temp, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (chunk) => { output += String(chunk); });
  child.stderr!.on("data", (chunk) => { output += String(chunk); });
  await waitFor(() => !!socket, "onebot connect");
  await new Promise((resolve) => setTimeout(resolve, 300));
}
async function stopBridge(): Promise<void> {
  if (child && child.exitCode === null && child.signalCode === null) {
    const done = new Promise((resolve) => child!.once("close", resolve));
    child.kill("SIGTERM");
    await done;
  }
  child = undefined;
}

try {
  cpSync(path.join(root, "src"), path.join(temp, "src"), { recursive: true });
  mkdirSync(path.join(temp, "schedule"));
  cpSync(path.join(root, "schedule", "zf.ts"), path.join(temp, "schedule", "zf.ts"));
  mkdirSync(path.join(temp, "sandbox"));
  mkdirSync(path.join(temp, "stickers"));
  writeFileSync(path.join(temp, "stickers", "manifest.json"), JSON.stringify({ version: 1, stickers: [] }));
  writeFileSync(path.join(temp, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(path.join(temp, "modes.json"), JSON.stringify({ entertainment: { groups: [entGroup] } }));

  await startBridge(false);

  // ── 娱乐模式群 + 院长：合成并发出 record 段 ──
  {
    emit("CASE_VOICE_OK 用语音把课表念一遍", entGroup);
    await waitFor(() => records().length === 1, "voice record");
    const record = records()[0];
    const file = String(record.params.message[0].data.file);
    assert.match(file, /^base64:\/\//, "优先内联 base64，不落盘");
    assert.deepEqual(Buffer.from(file.slice("base64://".length), "base64"), AUDIO, "record 里就是合成出的音频字节");
    assert.equal(record.params.group_id, entGroup, "只发到当前群");
    const tts = ttsRequests.at(-1)!;
    assert.equal(tts.url, "/v1/t2a_v2");
    assert.equal(tts.auth, `Bearer ${FAKE_KEY}`);
    assert.equal(tts.body.text, SPOKEN);
    assert.equal(tts.body.model, "speech-2.8-selftest");
    assert.equal(tts.body.voice_setting.voice_id, "female-yujie", "中文音色名应命中白名单");
    // 语音就是本轮的回复：桥接不得在语音之后补发文字或表情包
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(plainMessages().length, 0, "语音之后不应再发文字或表情包");
    assert.equal(anySent("RESULT"), false, "工具返回的确认文字不得当成群消息发出");
    assert.match(output, /本轮已发语音，跳过/, "桥接应记录跳过文字的分支");
    console.log("PASS bridge: 娱乐模式群院长调用 → MiniMax 假接口合成 → 当前群 record，之后不再补发文字");
  }

  // ── 未知音色静默回退配置默认 ──
  {
    const before = records().length;
    emit("CASE_VOICE_BADVOICE 用语音念一下", entGroup);
    await waitFor(() => records().length === before + 1, "fallback voice record");
    assert.equal(ttsRequests.at(-1)!.body.voice_setting.voice_id, "female-shaonv", "未知音色回退 tts.voiceId");
    console.log("PASS bridge: 未知音色回退默认 voiceId，不把编造的 id 发给接口");
  }

  // ── 超长：不合成、不发送 ──
  {
    const before = records().length;
    const ttsBefore = ttsRequests.length;
    emit("CASE_VOICE_LONG 念这段", entGroup);
    await waitFor(() => anySent("太长"), "long rejection");
    assert.match(textOf(sent.at(-1)), /200 字以内/);
    assert.equal(records().length, before, "超长不得发送语音");
    assert.equal(ttsRequests.length, ttsBefore, "超长不得调用合成接口");
    console.log("PASS bridge: 超长文本 → ok:false 提示缩短，零合成零发送");
  }

  // ── 合成失败：降级为文字，不发送 ──
  {
    const before = records().length;
    ttsMode = "fail";
    emit("CASE_VOICE_FAIL 用语音念一下", entGroup);
    await waitFor(() => anySent("语音合成失败"), "synth failure");
    assert.equal(records().length, before, "合成失败不得发送语音");
    ttsMode = "ok";
    console.log("PASS bridge: 合成失败 → 工具 ok:false，正常文字回复照发");
  }

  // ── 非娱乐模式群：拒绝且不合成 ──
  {
    const before = records().length;
    const ttsBefore = ttsRequests.length;
    emit("CASE_VOICE_NORMAL 用语音念一下", normalGroup);
    await waitFor(() => anySent("只有娱乐模式群"), "normal mode rejection");
    assert.equal(records().length, before);
    assert.equal(ttsRequests.length, ttsBefore, "非娱乐模式不得调用合成接口");
    console.log("PASS bridge: 非娱乐模式群 → 只有娱乐模式群可用，零副作用");
  }

  // ── 娱乐模式群 + 非院长/非白名单：默认拒绝 ──
  {
    const before = records().length;
    const ttsBefore = ttsRequests.length;
    emit("CASE_VOICE_STRANGER 用语音念一下", entGroup, stranger);
    await waitFor(() => anySent("仅院长可指定语音"), "owner-only rejection");
    assert.equal(records().length, before);
    assert.equal(ttsRequests.length, ttsBefore);
    console.log("PASS bridge: allowOthers 缺省 → 群友指定语音被拒绝，零副作用");
  }

  await stopBridge();
  socket = undefined;

  // ── allowOthers=true：群友也能指定语音 ──
  await startBridge(true);
  {
    const before = records().length;
    const msgsBefore = plainMessages().length;
    emit("CASE_VOICE_ALLOW 用语音念一下", entGroup, stranger);
    await waitFor(() => records().length === before + 1, "allowOthers record");
    assert.equal(records().at(-1)!.params.group_id, entGroup);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(
      plainMessages().length, msgsBefore,
      "allowOthers 语音成功之后同样不得补发文字",
    );
    console.log("PASS bridge: allowOthers=true → 群友指定语音被放行，且不发多余文字");
  }

  assert.doesNotMatch(output, /ReferenceError|TypeError|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED/, "桥接日志不应有运行时错误");
  assert.equal(output.includes(FAKE_KEY), false, "桥接日志不得出现密钥");
  assert.equal(output.includes(SPOKEN), false, "桥接日志不得出现朗读文本全文");
  console.log("PASS bridge logs: 不记录密钥与朗读文本");
  console.log("voice-bridge-selftest: all passed（临时项目、假 OneBot、假 TTS；未连接真实 QQ、未调用 MiniMax）");
} finally {
  await stopBridge();
  for (const ws of server.clients) ws.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => ttsServer.close(() => resolve()));
  rmSync(temp, { recursive: true, force: true });
}
