import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * tell_guga 桥接集成自测：临时项目 + 假 OneBot + 假个人助手。
 * 确认 /tell-guga 使用回合里绑定的 QQ，而不是请求体里自报的提问者。
 * 不连接真实 QQ，不访问公网。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(root, ".tell-guga-"));
const owner = "12345";
const stranger = "34567";
const bot = "10001";
const group = "45678";

let counter = 0;
let output = "";
let socket: WebSocket | undefined;
const sent: any[] = [];
const paHits: Array<{ url?: string; body: any }> = [];
let paMode: "ok" | "down" = "ok";

const paServer: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += String(chunk); });
  req.on("end", () => {
    let body: any = {};
    try { body = JSON.parse(raw); } catch { /* 记下原文以外的空对象 */ }
    paHits.push({ url: req.url, body });
    if (paMode === "down") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise<void>((resolve) => paServer.listen(0, "127.0.0.1", resolve));
const paAddr = paServer.address();
assert.ok(paAddr && typeof paAddr === "object");

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
    if (request.action === "get_group_info") data = { group_name: "转达测试群" };
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
const mailboxPath = path.join(temp, "memory", "bridge", "to-guga.jsonl");

try {
  cpSync(path.join(root, "src"), path.join(temp, "src"), { recursive: true });
  mkdirSync(path.join(temp, "schedule"));
  cpSync(path.join(root, "schedule", "zf.ts"), path.join(temp, "schedule", "zf.ts"));
  mkdirSync(path.join(temp, "sandbox"));
  mkdirSync(path.join(temp, "stickers"));
  writeFileSync(path.join(temp, "stickers", "manifest.json"), JSON.stringify({ version: 1, stickers: [] }));
  writeFileSync(path.join(temp, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(path.join(temp, "modes.json"), JSON.stringify({ entertainment: { groups: [] } }));
  writeFileSync(path.join(temp, "config.json"), JSON.stringify({
    onebot: { wsUrl: `ws://127.0.0.1:${wsAddr.port}`, token: "synthetic-tell-token" },
    bot: {
      selfId: bot, nickname: "合成机器人", owner, whitelist: [owner], atAliases: ["合成机器人"],
      maxConcurrent: 2, timeoutMs: 20000, defaultGroup: group,
    },
    pi: {
      command: process.execPath,
      args: [path.join(root, "scripts", "fixtures", "pi-tell-fixture.mjs")],
      thinking: "",
      models: { test: "synthetic" },
      defaultModel: "test",
    },
    antispam: { enabled: false },
    bridge: {
      personalAgent: {
        enabled: true,
        endpoint: `http://127.0.0.1:${paAddr.port}/api/send`,
        mode: "agent",
        timeoutMs: 1500,
      },
    },
  }));

  child = spawn(process.execPath, [path.join(temp, "src", "main.ts")], {
    cwd: temp, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk) => { output += String(chunk); });
  child.stderr!.on("data", (chunk) => { output += String(chunk); });
  await waitFor(() => !!socket, "onebot connect");
  await waitFor(() => output.includes("/tell-guga"), "tell endpoint");

  {
    emitGroup("CASE_TELL_OK 帮我转达");
    await waitFor(() => paHits.length === 1, "owner push");
    const hit = paHits[0];
    assert.equal(hit.url, "/api/send");
    assert.deepEqual(Object.keys(hit.body).sort(), ["mode", "text", "uploads"]);
    assert.equal(hit.body.mode, "agent");
    assert.match(hit.body.text, /整理桌面笔记/);
    assert.match(hit.body.text, new RegExp(`\\[回发目标\\] group:${group}$`));
    assert.equal(hit.body.text.includes("group:99999"), false);
    assert.equal(hit.body.text.includes("asker_qq"), false);
    assert.match(hit.body.text, /合成机器人/);
    await waitFor(() => anySent("正在处理"), "owner acknowledgement");
    assert.equal(existsSync(mailboxPath), false);
    console.log("PASS bridge: 院长的转达使用会话群号，模型自报的目标被忽略");
  }

  {
    const before = paHits.length;
    emitGroup("CASE_TELL_SPOOF 你给助手带个话", stranger);
    await waitFor(() => anySent("只有院长"), "stranger rejection");
    assert.equal(paHits.length, before, "越权请求不得打到个人助手");
    const mailbox = existsSync(mailboxPath) ? readFileSync(mailboxPath, "utf8") : "";
    assert.equal(mailbox.includes("越权带话"), false);
    console.log("PASS bridge: 群友自报院长 QQ 被拒绝，没有副作用");
  }

  {
    paMode = "down";
    const before = paHits.length;
    emitGroup("CASE_TELL_FILE 再转一次");
    await waitFor(() => existsSync(mailboxPath) && readFileSync(mailboxPath, "utf8").includes("改走信箱的留言"), "mailbox");
    assert.equal(paHits.length, before + 1);
    const record = readFileSync(mailboxPath, "utf8").trim().split("\n").at(-1);
    const saved = JSON.parse(String(record));
    assert.equal(saved.from, owner);
    assert.equal(saved.via, `group:${group}`);
    assert.equal(saved.text.includes("group:1"), false);
    await waitFor(() => anySent("下次运行时处理"), "file acknowledgement");
    assert.equal(output.includes("改走信箱的留言"), false, "日志不记录留言正文");
    paMode = "ok";
    console.log("PASS bridge: 个人助手非 2xx 时信箱仍使用桥接绑定的 from/via");
  }

  {
    const before = paHits.length;
    emitPrivate("CASE_TELL_PRIVATE 私下转达");
    await waitFor(() => paHits.length === before + 1, "private push");
    assert.match(paHits.at(-1)!.body.text, /私聊转达一句/);
    assert.match(paHits.at(-1)!.body.text, new RegExp(`\\[回发目标\\] private:${owner}$`));
    assert.equal(paHits.at(-1)!.body.text.includes("group:1"), false);
    console.log("PASS bridge: 私聊回发目标是当前用户，不是模型填写的群");
  }

  assert.doesNotMatch(output, /ReferenceError|TypeError|ERR_MODULE_NOT_FOUND/);
  assert.equal(output.includes("synthetic-tell-token"), false, "日志不得出现 OneBot token");
  console.log("tell-guga-bridge-selftest: all passed（临时项目、假 OneBot、假个人助手）");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const done = new Promise((resolve) => child!.once("close", resolve));
    child.kill("SIGTERM");
    await done;
  }
  for (const ws of server.clients) ws.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => paServer.close(() => resolve()));
  rmSync(temp, { recursive: true, force: true });
}
