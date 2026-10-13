import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer, type WebSocket } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Keep code under the project so dependencies resolve, but use only synthetic runtime data.
const temp = mkdtempSync(path.join(root, ".knowledge-smoke-"));
const owner = "12345", bot = "34567", group = "45678";
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const sent: any[] = [];
let socket: WebSocket | undefined;
let counter = 0;
server.on("connection", ws => {
  socket = ws;
  ws.on("message", raw => {
    const request = JSON.parse(String(raw));
    let data: any = {};
    if (request.action === "get_group_list" || request.action === "get_group_member_list") data = [];
    if (request.action === "get_group_info") data = { group_name: "合成测试群" };
    if (request.action.startsWith("send_")) { sent.push(request); data = { message_id: ++counter, forward_id: `fixture-${counter}` }; }
    ws.send(JSON.stringify({ status: "ok", retcode: 0, data, echo: request.echo }));
  });
});
let child: ReturnType<typeof spawn> | undefined;
let output = "";
async function waitFor(test: () => boolean, label: string) {
  const deadline = Date.now() + 15000;
  while (!test()) {
    if (child && child.exitCode !== null) throw new Error(`bridge exited (${child.exitCode}): ${output.slice(-3000)}`);
    if (Date.now() > deadline) throw new Error(`${label} timed out: ${output.slice(-3000)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
function emit(kind: "group" | "private", text: string, at = true) {
  socket!.send(JSON.stringify({ post_type: "message", message_type: kind, user_id: owner, group_id: group,
    message_id: ++counter, time: Math.floor(Date.now() / 1000), sender: { nickname: "合成用户", role: "member" },
    message: [...(kind === "group" && at ? [{ type: "at", data: { qq: bot } }] : []), { type: "text", data: { text } }],
  }));
}
function calls(): any[] {
  const file = path.join(temp, "sandbox", "fixture-calls.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(x => JSON.parse(x)) : [];
}
async function ask(kind: "group" | "private", text: string) {
  const before = sent.length;
  emit(kind, text);
  await waitFor(() => sent.length > before, text);
}
try {
  cpSync(path.join(root, "src"), path.join(temp, "src"), { recursive: true });
  mkdirSync(path.join(temp, "schedule"));
  cpSync(path.join(root, "schedule", "zf.ts"), path.join(temp, "schedule", "zf.ts"));
  mkdirSync(path.join(temp, "sandbox"));
  mkdirSync(path.join(temp, "memory", "long-term"), { recursive: true });
  writeFileSync(path.join(temp, "memory", "long-term", `${owner}.jsonl`), JSON.stringify({ id: "old", t: "2026-01-01", text: "合成旧偏好：短句" }) + "\n");
  writeFileSync(path.join(temp, "memory", `group-${group}.jsonl`), "旧会话不应进入\n");
  writeFileSync(path.join(temp, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(path.join(temp, "config.json"), JSON.stringify({
    onebot: { wsUrl: `ws://127.0.0.1:${address.port}`, token: "synthetic" },
    bot: { selfId: bot, nickname: "合成机器人", owner, whitelist: [owner], atAliases: ["合成机器人"], maxConcurrent: 2, timeoutMs: 5000, defaultGroup: group },
    pi: { command: process.execPath, args: [path.join(root, "scripts", "fixtures", "pi-bridge-fixture.mjs")], thinking: "", models: {} },
    antispam: { enabled: false },
    entertainment: { replyFrequency: 0 },
    knowledge: { enabled: true, groups: [group], privateUsers: [owner], automatic: false },
  }));
  child = spawn(process.execPath, [path.join(temp, "src", "main.ts")], { cwd: temp, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", chunk => { output += String(chunk); });
  child.stderr!.on("data", chunk => { output += String(chunk); });
  await waitFor(() => !!socket, "synthetic bridge connect");
  await ask("group", "开启记忆");
  await ask("private", "开启记忆");
  await new Promise(resolve => setTimeout(resolve, 1100));
  emit("group", "普通消息不应进入", false);
  await ask("group", "我正在学习 Python");
  let trace = calls();
  assert.equal(trace.length, 1);
  assert.ok(trace[0].tools.includes("memory_search"));
  assert.equal(trace[0].hasToken, true);
  assert.equal(trace[0].session, false);
  assert.ok(trace[0].protectedGroups.includes(group));
  assert.ok(trace[0].protectedUsers.includes(owner));
  assert.doesNotMatch(trace[0].prompt, /旧会话不应进入|普通消息不应进入|合成旧偏好/);
  console.log("PASS actual main: normal @ uses scoped context, no legacy session or ordinary chat");

  await ask("private", "我的回答习惯是什么？");
  trace = calls();
  assert.equal(trace.at(-1).hasToken, true);
  assert.match(trace.at(-1).prompt, /合成旧偏好：短句/);
  assert.equal(readFileSync(path.join(temp, "memory", "long-term", `${owner}.jsonl`), "utf8"), JSON.stringify({ id: "old", t: "2026-01-01", text: "合成旧偏好：短句" }) + "\n");
  console.log("PASS actual main: private legacy memory is read without changing its file");

  await ask("group", "开启娱乐模式");
  await ask("group", "我喜欢另一种学习路线");
  trace = calls();
  assert.equal(trace.at(-1).hasToken, false);
  assert.ok(!trace.at(-1).tools.includes("memory_search"));
  // 娱乐模式不接新记忆，但提示词必须带上群聊记录——只 @ 不说话时要靠它接上文
  assert.match(trace.at(-1).prompt, /\[群里最近的聊天记录/);
  await ask("group", "关闭娱乐模式");
  await ask("group", "关闭记忆");
  await ask("group", "停用后继续问答");
  trace = calls();
  assert.equal(trace.at(-1).hasToken, false);
  assert.equal(trace.at(-1).session, false);
  assert.doesNotMatch(trace.at(-1).prompt, /旧会话不应进入|普通消息不应进入|合成旧偏好/);
  console.log("PASS actual main: entertainment excluded; disabled managed scope never falls back");

  // 桥接回发：长报告先整理成简洁答复再发，短回发不经过整理
  const longReport = "本机个人助手的完整报告。" + "查证过程与文件路径细节。".repeat(70); // 约 900 字
  const shortReply = "今天没有课，安心休息。";
  mkdirSync(path.join(temp, "memory", "bridge"), { recursive: true });
  writeFileSync(path.join(temp, "memory", "bridge", "to-qq.jsonl"),
    JSON.stringify({ t: new Date().toISOString(), type: "private", id: owner, text: longReport }) + "\n" +
    JSON.stringify({ t: new Date().toISOString(), type: "private", id: owner, text: shortReply }) + "\n");
  const privateSends = () => sent.filter(s => s.action === "send_msg" && s.params.message_type === "private");
  await waitFor(() => privateSends().length >= 2, "bridge outbox forwarded");
  await new Promise(resolve => setTimeout(resolve, 1500)); // 等两条回发都处理完
  const forwarded = privateSends()
    .flatMap(s => s.params.message.map((seg: any) => String(seg.data?.text ?? "")))
    .map(t => t.trim());
  assert.ok(!forwarded.includes(longReport.trim()), "long PA report must not be forwarded verbatim");
  assert.ok(forwarded.includes(shortReply), "short PA reply must pass through unchanged");
  const compacted = forwarded.find(t => t.includes("已重启"));
  assert.ok(compacted, "compacted text was not forwarded");
  assert.ok(compacted!.length <= 80, "compacted reply must stay short");
  assert.doesNotMatch(compacted!, /PID|\\pi-napcatqq/, "compacted output must be sanitized");
  // 整理用的提示词必须带上原文与「删掉过程细节」的约束，且不带工具
  const callsAll = calls();
  assert.ok(callsAll.some(c => c.prompt.includes(longReport) && /PID/.test(c.prompt)),
    "compaction prompt must embed the full report and the strip-work-details rule");
  const compactTrace = callsAll.find(c => c.prompt.includes("回复全文："));
  assert.ok(compactTrace, "compaction must use the compact prompt");
  assert.equal(compactTrace!.tools, "", "compaction call must run without tools");
  const compactInput = readFileSync(path.join(temp, "sandbox", "last-compact-input.txt"), "utf8");
  assert.ok(compactInput.includes(longReport), "fixture must receive the full report");
  console.log("PASS actual main: long PA report compacted before QQ, short reply unchanged");

  const db = new DatabaseSync(path.join(temp, "memory", "knowledge.sqlite"), { readOnly: true });
  try {
    const sources = db.prepare("SELECT text FROM sources").all() as { text: string }[];
    assert.ok(sources.some(s => s.text === "我正在学习 Python"));
    assert.ok(sources.some(s => s.text === "我的回答习惯是什么？"));
    assert.ok(!sources.some(s => /普通消息|另一种学习路线|停用后/.test(s.text)));
  } finally { db.close(); }
  assert.doesNotMatch(output, /ReferenceError|TypeError|BAD: OLD CONTEXT LEAK/);
  console.log("bridge-smoke-selftest: 5/5 passed (temporary main, fake OneBot, fixture model only)");
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
