import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * 特权工具桥接集成自测：临时项目 + 假 OneBot。
 * 确认 model_manage / send_group_message / 记忆 / task_manage
 * 使用回合里绑定的 QQ，而不是请求体里自报的 asker_qq。
 * 不连接真实 QQ。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(root, ".privileged-"));
const owner = "12345";
const stranger = "34567";
const bot = "10002";
const group = "45678";
const other = "45679";

let counter = 0;
let output = "";
let socket: WebSocket | undefined;
const sent: any[] = [];
const statePath = path.join(temp, ".model-state.json");
const configPath = path.join(temp, "config.json");
const outboxPath = path.join(temp, "memory", "outbox.jsonl");
const ownerMemory = path.join(temp, "memory", "long-term", `${owner}.jsonl`);

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
    if (request.action === "get_group_info") data = { group_name: "身份测试群" };
    if (request.action.startsWith("send_")) {
      sent.push(request);
      data = { message_id: ++counter };
    }
    ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo, data }));
  });
});

function textOf(request: any): string {
  return JSON.stringify(request.params ?? {});
}
function anySent(fragment: string): boolean {
  return sent.some((item) => textOf(item).includes(fragment));
}
function countSent(fragment: string): number {
  return sent.filter((item) => textOf(item).includes(fragment)).length;
}
function alias(): string {
  return JSON.parse(readFileSync(statePath, "utf8")).alias;
}
function taskList(): unknown {
  return JSON.parse(readFileSync(configPath, "utf8")).tasks ?? null;
}
function memoryText(): string {
  return existsSync(ownerMemory) ? readFileSync(ownerMemory, "utf8") : "";
}
function sendLanded(body: string, gid: string): boolean {
  if (existsSync(outboxPath)) {
    const raw = readFileSync(outboxPath, "utf8");
    if (raw.includes(body) && raw.includes(gid) && !raw.includes("asker_qq")) return true;
  }
  return sent.some((item) => {
    const params = item.params ?? {};
    const blob = JSON.stringify(params);
    return blob.includes(body) && String(params.group_id ?? "") === gid && !blob.includes("asker_qq");
  });
}
async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 25000;
  while (!check()) {
    if (child && child.exitCode !== null) throw new Error(`bridge exited: ${output.slice(-2000)}`);
    if (Date.now() > deadline) throw new Error(`${label} timed out: ${output.slice(-2500)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
function emitGroup(text: string, userId = owner): void {
  socket!.send(JSON.stringify({
    post_type: "message", message_type: "group", user_id: userId, group_id: group,
    message_id: ++counter, time: Math.floor(Date.now() / 1000),
    sender: { nickname: userId === owner ? "院长" : "群友", role: "member" },
    message: [{ type: "at", data: { qq: bot } }, { type: "text", data: { text } }],
  }));
}

let child: ReturnType<typeof spawn> | undefined;

try {
  cpSync(path.join(root, "src"), path.join(temp, "src"), { recursive: true });
  mkdirSync(path.join(temp, "schedule"));
  cpSync(path.join(root, "schedule", "zf.ts"), path.join(temp, "schedule", "zf.ts"));
  mkdirSync(path.join(temp, "sandbox"));
  mkdirSync(path.join(temp, "stickers"));
  writeFileSync(path.join(temp, "stickers", "manifest.json"), JSON.stringify({ version: 1, stickers: [] }));
  writeFileSync(path.join(temp, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(path.join(temp, "modes.json"), JSON.stringify({ entertainment: { groups: [] } }, null, 2) + "\n");
  writeFileSync(statePath, JSON.stringify({ alias: "test" }, null, 2));
  writeFileSync(configPath, JSON.stringify({
    onebot: { wsUrl: `ws://127.0.0.1:${wsAddr.port}`, token: "synthetic-privileged-token" },
    bot: {
      selfId: bot, nickname: "合成机器人", owner, whitelist: [owner, stranger], atAliases: ["合成机器人"],
      maxConcurrent: 2, timeoutMs: 20000, defaultGroup: other,
    },
    pi: {
      command: process.execPath,
      args: [path.join(root, "scripts", "fixtures", "pi-privileged-fixture.mjs")],
      thinking: "",
      models: { test: "synthetic-public", hidden: "secret-model-id" },
      defaultModel: "test",
    },
    antispam: { enabled: false },
    entertainment: { replyFrequency: 0 },
  }));

  child = spawn(process.execPath, [path.join(temp, "src", "main.ts")], {
    cwd: temp, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk) => { output += String(chunk); });
  child.stderr!.on("data", (chunk) => { output += String(chunk); });
  await waitFor(() => !!socket, "onebot connect");
  await waitFor(() => output.includes("/task-manage"), "privileged endpoints");

  emitGroup("CASE_MODEL_SPOOF 切到隐藏模型", stranger);
  await waitFor(() => anySent("只有院长可以查询或切换模型"), "model spoof rejection");
  assert.equal(alias(), "test");
  assert.equal(JSON.stringify(sent).includes("secret-model-id"), false);
  console.log("PASS bridge: 群友自报院长 QQ 切不了模型，状态文件不变");

  emitGroup("CASE_MODEL_STATUS 现在什么模型", stranger);
  await waitFor(() => countSent("只有院长可以查询或切换模型") >= 2, "model status spoof");
  assert.equal(JSON.stringify(sent).includes("secret-model-id"), false);
  console.log("PASS bridge: 群友自报院长 QQ 也查不到模型名");

  emitGroup("CASE_MODEL_OK 换成隐藏模型");
  await waitFor(() => anySent("已切到 hidden"), "owner switch");
  await waitFor(() => alias() === "hidden", "alias persisted");
  console.log("PASS bridge: 院长切换写入的是会话身份，不是请求体里的 QQ");

  emitGroup("CASE_SEND_SPOOF 发到别的群", stranger);
  await waitFor(() => anySent("只有院长可以让我往群里发消息"), "send spoof rejection");
  assert.equal(JSON.stringify(sent).includes("不该发出去"), false);
  if (existsSync(outboxPath)) assert.equal(readFileSync(outboxPath, "utf8").includes("不该发出去"), false);
  console.log("PASS bridge: 群友自报院长 QQ 不会把消息写入发件箱");

  emitGroup("CASE_SEND_OK 发群通知");
  await waitFor(() => anySent("已提交"), "owner send ack");
  await waitFor(() => sendLanded("群通知正文甲", group), "owner send queued");
  assert.equal(sendLanded("群通知正文甲", "99999"), false);
  console.log("PASS bridge: 院长发群用的是提交的目标群，提问者仍以会话为准");

  emitGroup("CASE_MEM_OK 记住这个");
  await waitFor(() => anySent("MEMTOKEN9527"), "owner remember");
  await waitFor(() => memoryText().includes("MEMTOKEN9527"), "owner memory persisted");
  const leaks = countSent("MEMTOKEN9527");

  emitGroup("CASE_MEM_RECALL 你记得什么", stranger);
  await waitFor(() => anySent("还没有任何条目"), "stranger recall");
  assert.equal(countSent("MEMTOKEN9527"), leaks);
  assert.equal(memoryText().includes("MEMTOKEN9527"), true);
  console.log("PASS bridge: 群友自报院长 QQ 读不到院长的记忆");

  emitGroup("CASE_MEM_SPOOF 替我记住", stranger);
  await waitFor(() => anySent("只有院长可以让我记住事情"), "memory spoof rejection");
  assert.equal(memoryText().includes("SPOOFMEM777"), false);
  assert.equal(JSON.stringify(sent).includes("SPOOFMEM777"), false);
  console.log("PASS bridge: 群友自报院长 QQ 写不进院长档案");

  const beforeTasks = taskList();
  emitGroup("CASE_TASK_SPOOF 每天提醒", stranger);
  await waitFor(() => anySent("只有院长可以管理定时任务"), "task spoof rejection");
  assert.equal(JSON.stringify(taskList()), JSON.stringify(beforeTasks));
  console.log("PASS bridge: 群友自报院长 QQ 改不了定时任务");

  emitGroup("CASE_TASK_OK 每天七点半提醒我");
  await waitFor(() => anySent("已完成"), "owner task");
  await waitFor(() => {
    const tasks = taskList();
    return Array.isArray(tasks) && tasks.length === 1;
  }, "task persisted");
  const tasks = taskList() as Array<{ name: string; target: { type: string; id: string } }>;
  assert.equal(tasks[0].name, "课表提醒");
  assert.deepEqual(tasks[0].target, { type: "private", id: owner });
  assert.equal(JSON.stringify(tasks).includes("99999"), false);
  assert.equal(JSON.stringify(tasks).includes("asker_qq"), false);
  console.log("PASS bridge: 院长建的私聊任务目标是会话里的院长，不是请求体里的号码");

  assert.doesNotMatch(output, /ReferenceError|TypeError|ERR_MODULE_NOT_FOUND/);
  assert.equal(output.includes("synthetic-privileged-token"), false);
  assert.equal(JSON.stringify(sent).includes("asker_qq"), false);
  console.log("privileged-bridge-selftest: all passed（临时项目、假 OneBot）");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const done = new Promise((resolve) => child!.once("close", resolve));
    child.kill("SIGTERM");
    await done;
  }
  for (const ws of server.clients) ws.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(temp, { recursive: true, force: true });
}
