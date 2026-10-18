import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";
import { ModeTurns, groupSessionKey } from "../src/mode-turns.ts";
import { chatDate, parseChatLog } from "../src/group-chat.ts";

const flags = new Map<string, boolean>([["a", true]]);
const turns = new ModeTurns(g => flags.get(g) ?? false);
const a = turns.begin("a"), b = turns.begin("b"), privateTurn = turns.begin();
flags.set("a", false); turns.invalidate("a"); flags.set("a", true); turns.invalidate("a");
assert.equal(a.isCurrent(), false);
assert.equal(a.signal.aborted, true);
assert.equal(b.isCurrent(), true);
assert.equal(privateTurn.isCurrent(), true);
const nextA = turns.begin("a"); a.finish();
assert.equal(nextA.isCurrent(), true);
turns.close();
assert.equal(nextA.signal.aborted, true);
assert.equal(b.signal.aborted, true);
assert.equal(turns.begin("a").isCurrent(), false);
assert.notEqual(groupSessionKey("a", false), groupSessionKey("a", true));
console.log("PASS mode guard: snapshot、ABA、分组取消、私聊隔离、释放和关闭");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(root, ".mode-switch-"));
const owner = "12345", bot = "34567", group = "45678", otherGroup = "45679", proGroup = "45680", summaryGroup = "45681", rejectGroup = "45682";
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
let socket: WebSocket | undefined, child: ReturnType<typeof spawn> | undefined;
let counter = 0, output = "";
const sent: any[] = [];
let slowQuote: { echo: string; ws: WebSocket } | undefined;
let imageRejection: { echo: string; ws: WebSocket } | undefined;
server.on("connection", ws => {
  socket = ws;
  ws.on("message", raw => {
    const request = JSON.parse(String(raw));
    if (request.action === "get_msg" && request.params.message_id === "slow-quote") {
      slowQuote = { echo: request.echo, ws }; return;
    }
    let data: any = {};
    if (request.action === "get_group_list" || request.action === "get_group_member_list") data = [];
    if (request.action === "get_group_info") data = { group_name: "模式隔离测试群" };
    if (request.action.startsWith("send_")) {
      sent.push(request);
      if (request.action === "send_msg" && String(request.params.group_id) === rejectGroup
        && request.params.message.some((s: any) => s.type === "image")) {
        imageRejection = { echo: request.echo, ws }; return;
      }
      data = { message_id: ++counter, forward_id: `fixture-${counter}` };
    }
    ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo, data }));
  });
});
const memory = path.join(temp, "memory");
const callsPath = path.join(temp, "sandbox", "mode-calls.jsonl");
const calls = (): any[] => existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map(x => JSON.parse(x)) : [];
function textOf(request: any): string {
  return JSON.stringify(request.params);
}
function wasSent(text: string): boolean { return sent.some(s => textOf(s).includes(text)); }
async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (child && child.exitCode !== null) throw new Error(`bridge exited: ${output.slice(-2000)}`);
    if (Date.now() > deadline) throw new Error(`${label} timed out: ${output.slice(-2500)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function emit(text: string, gid = group, at = true, extra: any[] = []) {
  socket!.send(JSON.stringify({ post_type: "message", message_type: "group", user_id: owner, group_id: gid,
    message_id: ++counter, time: Math.floor(Date.now() / 1000), sender: { nickname: "合成用户", role: "member" },
    message: [...(at ? [{ type: "at", data: { qq: bot } }] : []), { type: "text", data: { text } }, ...extra],
  }));
}
async function toggle(on: boolean, gid = group) {
  const before = sent.length;
  emit(`${on ? "开启" : "关闭"}娱乐模式`, gid);
  await waitFor(() => sent.slice(before).some(s => textOf(s).includes(`娱乐模式已${on ? "开启" : "关闭"}`)), "mode acknowledgement");
}
async function ask(key: string, gid = group, prefix = "") {
  emit(prefix + key, gid);
  await waitFor(() => calls().some(c => c.key === key), key + " started");
  await waitFor(() => wasSent(`answer:${key}`), key + " sent");
  return calls().find(c => c.key === key);
}
function release(key: string) { writeFileSync(path.join(temp, "sandbox", `release-${key}`), "ok"); }
const modeSession = (gid: string, entertainment: boolean) => path.join(memory, `${groupSessionKey(gid, entertainment)}.jsonl`);
try {
  cpSync(path.join(root, "src"), path.join(temp, "src"), { recursive: true });
  mkdirSync(path.join(temp, "schedule")); cpSync(path.join(root, "schedule", "zf.ts"), path.join(temp, "schedule", "zf.ts"));
  mkdirSync(path.join(temp, "sandbox")); mkdirSync(path.join(temp, "stickers")); mkdirSync(path.join(memory, "group-chat"), { recursive: true });
  const old = "LEGACY_MIXED_PROTOCOL " + '{"text":"旧娱乐会话","sticker":null}\n'.repeat(60);
  const legacy = path.join(memory, `group-${group}.jsonl`), oldEnt = path.join(memory, `ent-group-${group}.jsonl`);
  writeFileSync(legacy, old); writeFileSync(oldEnt, old);
  const stamp = new Date().toISOString();
  writeFileSync(path.join(memory, "group-chat", `${group}-${chatDate()}.jsonl`), [
    { t: stamp, u: owner, n: "甲", m: "正常历史证据", entertainment: false },
    { t: stamp, u: owner, n: "甲", m: "娱乐历史证据", entertainment: true },
    { t: stamp, u: owner, n: "甲", m: "旧未标记历史证据" },
    { t: stamp, u: bot, n: "机器人", m: JSON.stringify({ text: "历史正文", sticker: "old_secret" }), entertainment: false },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(path.join(temp, "stickers", "happy.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  writeFileSync(path.join(temp, "stickers", "manifest.json"), JSON.stringify({ version: 1, stickers: [{ id: "happy", file: "happy.png", name: "开心", description: "合成素材" }] }));
  writeFileSync(path.join(temp, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(path.join(temp, "modes.json"), JSON.stringify({ entertainment: { groups: [proGroup, rejectGroup] } }));
  writeFileSync(path.join(temp, "config.json"), JSON.stringify({
    onebot: { wsUrl: `ws://127.0.0.1:${address.port}`, token: "synthetic" },
    bot: { selfId: bot, nickname: "合成机器人", owner, whitelist: [owner], atAliases: ["合成机器人"], maxConcurrent: 3, timeoutMs: 12000 },
    pi: { command: process.execPath, args: [path.join(root, "scripts", "fixtures", "pi-modes-fixture.mjs")], thinking: "", models: { test: "synthetic" }, defaultModel: "test" },
    antispam: { enabled: false }, entertainment: { replyFrequency: 1 },
  }));
  child = spawn(process.execPath, [path.join(temp, "src", "main.ts")], { cwd: temp, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", chunk => { output += String(chunk); }); child.stderr!.on("data", chunk => { output += String(chunk); });
  await waitFor(() => !!socket, "connect");

  let trace = await ask("CASE_NORMAL");
  assert.match(trace.prompt, /正常历史证据|历史正文/);
  assert.doesNotMatch(trace.prompt, /娱乐历史证据|旧未标记历史证据|old_secret|LEGACY_MIXED_PROTOCOL|\[回复协议\]/);
  assert.match(trace.session, /mode-v2-normal-group/);
  assert.equal(readFileSync(legacy, "utf8"), old); assert.equal(readFileSync(oldEnt, "utf8"), old);
  await toggle(true);
  trace = await ask("CASE_ENT_IMAGE");
  assert.match(trace.prompt, /娱乐历史证据/); assert.doesNotMatch(trace.prompt, /正常历史证据|历史正文/);
  assert.match(trace.session, /mode-v2-ent-group/);
  assert.ok(sent.some(s => textOf(s).includes("answer:CASE_ENT_IMAGE") && textOf(s).includes("base64://")));
  console.log("PASS main: 双向历史隔离、旧混合会话不读取/不删除，娱乐协议仍正常发图");

  emit("CASE_ENT_HOLD"); await waitFor(() => calls().some(c => c.key === "CASE_ENT_HOLD"), "ent pending");
  emit("CASE_ENT_QUEUED");
  await ask("CASE_OTHER_UNAFFECTED", otherGroup);
  const closeEnt = toggle(false); // 模式命令排在两个旧回合之后
  release("CASE_ENT_HOLD");
  await closeEnt;
  await waitFor(() => wasSent("answer:CASE_ENT_HOLD"), "held ent reply");
  await waitFor(() => wasSent("answer:CASE_ENT_QUEUED"), "queued ent reply");
  await ask("CASE_AFTER_ENT_CANCEL");
  console.log("PASS main: 模式命令按群内顺序排队；旧回合先完成，确认回复正常发送");

  emit("CASE_IDEMPOTENT_HOLD"); await waitFor(() => calls().some(c => c.key === "CASE_IDEMPOTENT_HOLD"), "idempotent pending");
  const idem = toggle(false); release("CASE_IDEMPOTENT_HOLD"); await idem;
  await waitFor(() => wasSent("answer:CASE_IDEMPOTENT_HOLD"), "same mode keeps turn");
  console.log("PASS main: 重复设置同一模式不会误取消合法回复");

  emit("CASE_PROACTIVE_HOLD", proGroup, false);
  await waitFor(() => calls().some(c => c.key === "CASE_PROACTIVE_HOLD"), "proactive pending");
  await toggle(false, proGroup); release("CASE_PROACTIVE_HOLD");
  await ask("CASE_AFTER_PROACTIVE", proGroup);
  assert.equal(wasSent("answer:CASE_PROACTIVE_HOLD"), false);
  console.log("PASS main: 已启动的主动插话在关模式后不发送");

  await toggle(false);
  let before = sent.length; emit("CASE_LEAK");
  await waitFor(() => sent.length > before && wasSent("已处理"), "normal JSON guard");
  assert.doesNotMatch(textOf(sent.at(-1)), /sticker|base64:\/\//);
  assert.equal(existsSync(modeSession(group, false)), false);
  assert.ok(readdirSync(path.join(memory, "archive")).some(f => f.startsWith(`protocol-${groupSessionKey(group, false)}`)));
  trace = await ask("CASE_AFTER_LEAK"); assert.equal(trace.previous, "");
  before = sent.length; emit("CASE_EMPTY"); await waitFor(() => sent.length > before, "empty protocol fallback");
  assert.doesNotMatch(textOf(sent.at(-1)), /sticker/);
  console.log("PASS main: 正常模式内部JSON只发正文，空协议给文字兜底，并隔离异常会话");

  before = sent.length; emit("请返回 JSON 原文 CASE_LITERAL"); await waitFor(() => sent.length > before, "literal JSON");
  assert.match(textOf(sent.at(-1)), /sticker/); assert.equal(existsSync(modeSession(group, false)), true);
  before = sent.length; emit("CASE_BUSINESS_JSON"); await waitFor(() => sent.length > before, "business JSON");
  assert.match(textOf(sent.at(-1)), /status/);
  const chat = parseChatLog(readFileSync(path.join(memory, "group-chat", `${group}-${chatDate()}.jsonl`), "utf8"));
  assert.ok(chat.some(e => e.u === bot && e.m === "已处理" && e.entertainment === false));
  assert.doesNotMatch(output, /ReferenceError|TypeError|ERR_MODULE_NOT_FOUND/);
  console.log("PASS main: 用户明确要求的 JSON 和普通业务 JSON 不被误拆，日志保存实际正文");
  console.log("mode-switch-selftest: all passed（临时项目、假 OneBot、可控模型；未连接真实 QQ）");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const done = new Promise(resolve => child!.once("close", resolve)); child.kill("SIGTERM"); await done;
  }
  for (const ws of server.clients) ws.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(temp, { recursive: true, force: true });
}
