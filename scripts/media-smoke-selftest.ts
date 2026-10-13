import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";
import { chatDate, parseChatLog } from "../src/group-chat.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(root, ".media-smoke-"));
const owner = "12345", other = "23456", bot = "34567", group = "45678", normalGroup = "56789";
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const sent: any[] = [];
const stored = new Map<string, any>();
let socket: WebSocket | undefined;
let counter = 0;
server.on("connection", ws => {
  socket = ws;
  ws.on("message", raw => {
    const request = JSON.parse(String(raw));
    let data: any = {};
    if (request.action === "get_group_list" || request.action === "get_group_member_list") data = [];
    if (request.action === "get_group_info") data = { group_name: "合成媒体测试群" };
    if (request.action === "get_msg") data = stored.get(String(request.params.message_id)) ?? {};
    if (request.action.startsWith("send_")) { sent.push(request); data = { message_id: ++counter, forward_id: `fixture-${counter}` }; }
    ws.send(JSON.stringify({ status: "ok", retcode: 0, data, echo: request.echo }));
  });
});
let child: ReturnType<typeof spawn> | undefined;
let output = "";
async function waitFor(test: () => boolean, label: string) {
  const deadline = Date.now() + 18000;
  while (!test()) {
    if (child && child.exitCode !== null) throw new Error(`bridge exited (${child.exitCode}): ${output.slice(-3000)}`);
    if (Date.now() > deadline) throw new Error(`${label} timed out: ${output.slice(-3000)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
function emit(message: any[], options: { at?: boolean; user?: string; gid?: string; private?: boolean } = {}) {
  const id = String(++counter);
  const event = { post_type: "message", message_type: options.private ? "private" : "group", user_id: options.user ?? owner,
    ...(options.private ? {} : { group_id: options.gid ?? group }), message_id: id, time: Math.floor(Date.now() / 1000),
    sender: { nickname: options.user === other ? "乙" : "甲", user_id: options.user ?? owner, role: "member" },
    message: [...(options.at ? [{ type: "at", data: { qq: bot } }] : []), ...message],
  };
  stored.set(id, event);
  socket!.send(JSON.stringify(event));
  return id;
}
function calls(): any[] {
  const file = path.join(temp, "sandbox", "fixture-calls.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(x => JSON.parse(x)) : [];
}
function chat(): string {
  const file = path.join(temp, "memory", "group-chat", `${group}-${chatDate()}.jsonl`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}
const segment = (text: string) => ({ type: "text", data: { text } });
async function ask(text: string, extra: any[] = [], options: { user?: string; gid?: string; private?: boolean } = {}) {
  const before = sent.length;
  emit([segment(text), ...extra], { ...options, at: !options.private });
  await waitFor(() => sent.length > before, text || "media question");
  return calls().filter(c => !c.vision).at(-1);
}
try {
  cpSync(path.join(root, "src"), path.join(temp, "src"), { recursive: true });
  mkdirSync(path.join(temp, "schedule"));
  cpSync(path.join(root, "schedule", "zf.ts"), path.join(temp, "schedule", "zf.ts"));
  mkdirSync(path.join(temp, "sandbox"));
  writeFileSync(path.join(temp, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(path.join(temp, "modes.json"), JSON.stringify({ entertainment: { groups: [group] } }));
  writeFileSync(path.join(temp, "config.json"), JSON.stringify({
    onebot: { wsUrl: `ws://127.0.0.1:${address.port}`, token: "synthetic" },
    bot: { selfId: bot, nickname: "合成机器人", owner, whitelist: [owner], atAliases: ["合成机器人"], maxConcurrent: 2, timeoutMs: 5000 },
    pi: { command: process.execPath, args: [path.join(root, "scripts", "fixtures", "pi-media-fixture.mjs")], thinking: "", models: { test: "synthetic" }, defaultModel: "test" },
    antispam: { enabled: false }, entertainment: { replyFrequency: 0 },
  }));
  const png = path.join(temp, "synthetic.png");
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT6UAAAAASUVORK5CYII=", "base64"));
  const image = { type: "image", data: { file: png, summary: "[动画表情]", sub_type: 1 } };
  child = spawn(process.execPath, [path.join(temp, "src", "main.ts")], { cwd: temp, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", chunk => { output += String(chunk); });
  child.stderr!.on("data", chunk => { output += String(chunk); });
  await waitFor(() => !!socket, "synthetic connect");

  const imageId = emit([image]);
  let trace = await ask("怎么样");
  assert.match(trace.prompt, /合成猫趴在桌上/);
  assert.match(trace.prompt, /我不干了/);
  assert.match(trace.prompt, /不确定梗的出处/);
  assert.match(trace.prompt, /甲（QQ 12345）/);
  assert.equal(trace.images.length, 0, "follow-up uses associated summary, not an unrelated raw image");
  assert.equal(calls().filter(c => c.vision).length, 1);
  const vision = calls().find(c => c.vision);
  assert.equal(vision.session, false);
  assert.equal(vision.noTools, true);
  assert.equal(vision.noExtensions, true);
  assert.equal(vision.images.length, 1);
  assert.equal(sent.length, 1, "background recognition must not speak in QQ");
  console.log("PASS actual main: 先发图后立即 @，后台摘要正确进入娱乐上下文，无额外回复");

  emit([image], { user: other });
  trace = await ask("刚才那张呢", [], { user: other });
  assert.match(trace.prompt, /乙（QQ 23456）/);
  assert.equal(calls().filter(c => c.vision).length, 1, "duplicate bytes use the cache");
  assert.equal(parseChatLog(chat()).filter(e => e.mediaCount).length, 2);
  console.log("PASS actual main: 重复图只识别一次，第二位发送者保留独立归属");

  emit([{ type: "face", data: { id: 480, raw: { faceText: "/散味儿" } } }]);
  trace = await ask("😂😂 🙃");
  assert.match(trace.prompt, /QQ表情：\/散味儿/);
  assert.match(trace.prompt, /😂😂 🙃/);
  assert.match(trace.prompt, /emoji 提示/);
  assert.match(trace.prompt, /反讽/);
  console.log("PASS actual main: QQ 表情名称和 emoji 原文/语义提示进入上下文");

  trace = await ask("直接看这张", [image]);
  assert.equal(trace.images.length, 1);
  assert.match(trace.prompt, /1 张图片（在附件里/);
  trace = await ask("引用这张", [{ type: "reply", data: { id: imageId } }]);
  assert.equal(trace.images.length, 1);
  console.log("PASS actual main: 同消息 @图片和显式引用均附原图");

  trace = await ask("这个图呢", [{ type: "image", data: { file: path.join(temp, "missing.png") } }]);
  assert.equal(trace.images.length, 0);
  assert.match(trace.prompt, /1 张图片未附上/);
  assert.doesNotMatch(trace.prompt, /1 张图片（在附件里/);
  trace = await ask("", [{ type: "face", data: { id: 480, raw: { faceText: "/散味儿" } } }], { private: true });
  assert.match(trace.prompt, /QQ表情：\/散味儿/);
  console.log("PASS actual main: 下载失败不声称附件可见，face-only 白名单私聊可触发");

  const callsBefore = calls().filter(c => c.vision).length;
  emit([image], { gid: normalGroup });
  await ask("普通群问答", [], { gid: normalGroup });
  assert.equal(calls().filter(c => c.vision).length, callsBefore, "normal group must not start automatic vision");
  socket!.send(JSON.stringify({ post_type: "notice", notice_type: "group_recall", group_id: group, message_id: imageId }));
  await waitFor(() => chat().includes('"kind":"recall"'), "recall logged");
  trace = await ask("撤回后呢");
  assert.doesNotMatch(trace.prompt, new RegExp(`消息 ${imageId}\\]`));
  assert.equal(parseChatLog(chat()).some(e => e.id === imageId), false);
  console.log("PASS actual main: 普通群不自动识别，撤回后新上下文不再包含该图");
  assert.doesNotMatch(output, /ReferenceError|TypeError|ERR_MODULE_NOT_FOUND/);
  console.log("media-smoke-selftest: 6/6 passed（临时 main、假 OneBot、合成模型，未连接 QQ）");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise(resolve => child!.once("close", resolve));
    child.kill("SIGTERM");
    await closed;
  }
  for (const ws of server.clients) ws.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(temp, { recursive: true, force: true });
}
