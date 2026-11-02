import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * mode_manage 桥接集成自测：临时项目 + 假 OneBot。
 * 确认 /mode-manage 使用回合里绑定的 QQ 和群，而不是请求体里自报的身份。
 * 不连接真实 QQ。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(root, ".mode-manage-"));
const owner = "12345";
const stranger = "34567";
const bot = "10002";
const group = "45678";
const other = "45679";
const named = "45680";

let counter = 0;
let output = "";
let socket: WebSocket | undefined;
const sent: any[] = [];
const modesPath = path.join(temp, "modes.json");

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
    if (request.action === "get_group_info") data = { group_name: "模式测试群" };
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
function groups(): string[] {
  const raw = JSON.parse(readFileSync(modesPath, "utf8"));
  return raw.entertainment.groups.map(String);
}
async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20000;
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
function emitPrivate(text: string, userId = owner): void {
  socket!.send(JSON.stringify({
    post_type: "message", message_type: "private", user_id: userId,
    message_id: ++counter, time: Math.floor(Date.now() / 1000),
    sender: { nickname: "院长" },
    message: [{ type: "text", data: { text } }],
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
  writeFileSync(modesPath, JSON.stringify({ entertainment: { groups: [] } }, null, 2) + "\n");
  writeFileSync(path.join(temp, "config.json"), JSON.stringify({
    onebot: { wsUrl: `ws://127.0.0.1:${wsAddr.port}`, token: "synthetic-mode-token" },
    bot: {
      selfId: bot, nickname: "合成机器人", owner, whitelist: [owner, stranger], atAliases: ["合成机器人"],
      maxConcurrent: 2, timeoutMs: 20000, defaultGroup: other,
    },
    pi: {
      command: process.execPath,
      args: [path.join(root, "scripts", "fixtures", "pi-mode-manage-fixture.mjs")],
      thinking: "",
      models: { test: "synthetic" },
      defaultModel: "test",
    },
    antispam: { enabled: false },
  }));

  child = spawn(process.execPath, [path.join(temp, "src", "main.ts")], {
    cwd: temp, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk) => { output += String(chunk); });
  child.stderr!.on("data", (chunk) => { output += String(chunk); });
  await waitFor(() => !!socket, "onebot connect");
  await waitFor(() => output.includes("/mode-manage"), "mode endpoint");

  emitGroup("CASE_MODE_ON 打开娱乐模式");
  await waitFor(() => anySent(`娱乐模式已开启：群 ${group}`), "owner enable");
  await waitFor(() => groups().includes(group) && !groups().includes("99999"), "session group persisted");
  console.log("PASS bridge: 院长开模式时写入当前群，伪造群号没有生效");

  const before = groups().join(",");
  emitGroup("CASE_MODE_SPOOF 关掉", stranger);
  await waitFor(() => anySent("只有院长"), "stranger rejection");
  assert.equal(groups().join(","), before);
  console.log("PASS bridge: 群友自报院长 QQ 被拒绝，modes.json 不变");

  emitPrivate("CASE_MODE_PRIVATE 给另一个群开");
  await waitFor(() => anySent(`娱乐模式已开启：群 ${named}`), "private named group");
  await waitFor(() => groups().includes(named) && groups().includes(group), "named group persisted");
  assert.equal(groups().includes("99999"), false);
  console.log("PASS bridge: 私聊里 group_id 是业务参数，提问者仍以会话为准");

  assert.doesNotMatch(output, /ReferenceError|TypeError|ERR_MODULE_NOT_FOUND/);
  assert.equal(output.includes("synthetic-mode-token"), false);
  console.log("mode-manage-bridge-selftest: all passed（临时项目、假 OneBot）");
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
