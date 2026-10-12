import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * 表情包端到端冒烟（临时副本 + 假 OneBot + 假 pi，不连接真实 QQ）：
 * 主动插话发图、被 @ 回复、冷却、坏协议/沉默/未知 ID/缺文件回退、正常模式不受影响。
 * 用法：node scripts/stickers-smoke-selftest.ts
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const temp = mkdtempSync(path.join(root, ".stickers-smoke-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HAPPY = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");

const sent: any[] = [];
const forwards: any[] = [];
let counter = 0;
let socket: WebSocket | undefined;
server.on("connection", (ws) => {
  socket = ws;
  ws.on("message", (raw) => {
    const req = JSON.parse(String(raw));
    let data: any = {};
    if (req.action === "get_group_list") data = [];
    else if (req.action === "get_group_member_list") data = [];
    else if (req.action === "get_group_info") data = { group_name: "合成测试群" };
    else if (req.action === "send_msg") {
      sent.push(req);
      data = { message_id: ++counter };
    } else if (req.action === "send_forward_msg") {
      forwards.push(req);
      data = { forward_id: `f${++counter}` };
    }
    ws.send(JSON.stringify({ status: "ok", retcode: 0, data, echo: req.echo }));
  });
});

const owner = "12345";
const bot = "34567";
const callsPath = path.join(temp, "calls.jsonl");
let child: ReturnType<typeof spawn> | undefined;
let output = "";

function calls(): Array<{ prompt: string }> {
  return existsSync(callsPath)
    ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
}
function ymd(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function emit(gid: string, text: string, at = false): void {
  socket!.send(
    JSON.stringify({
      post_type: "message",
      message_type: "group",
      group_id: gid,
      user_id: owner,
      message_id: ++counter,
      time: Math.floor(Date.now() / 1000),
      sender: { nickname: "合成用户", role: "member" },
      message: [...(at ? [{ type: "at", data: { qq: bot } }] : []), { type: "text", data: { text } }],
    }),
  );
}
function sentTo(gid: string): any[] {
  return sent.filter((r) => String(r.params.group_id) === gid);
}
function lastMessage(gid: string): any[] {
  return sentTo(gid).at(-1)?.params.message ?? [];
}
async function waitFor(test: () => boolean, label: string, ms = 20000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (child && child.exitCode !== null) throw new Error(`桥接提前退出（${child.exitCode}）：${output.slice(-2000)}`);
    if (Date.now() > end) throw new Error(`${label} 超时：${output.slice(-2000)}`);
    await sleep(25);
  }
}

try {
  // ── 临时项目：src 副本 + zf.ts + 素材 + 配置 + 娱乐模式群 ──
  cpSync(path.join(root, "src"), path.join(temp, "src"), { recursive: true });
  mkdirSync(path.join(temp, "schedule"), { recursive: true });
  cpSync(path.join(root, "schedule", "zf.ts"), path.join(temp, "schedule", "zf.ts"));
  mkdirSync(path.join(temp, "sandbox"), { recursive: true });
  mkdirSync(path.join(temp, "stickers"), { recursive: true });
  writeFileSync(path.join(temp, "stickers", "happy.png"), HAPPY);
  writeFileSync(path.join(temp, "stickers", "bubble.gif"), Buffer.from("4749463839", "hex"));
  writeFileSync(
    path.join(temp, "stickers", "manifest.json"),
    JSON.stringify({
      version: 1,
      stickers: [
        { id: "happy", file: "happy.png", name: "开心", description: "一起开心" },
        { id: "bubble", file: "bubble.gif", name: "冒泡", description: "轻松冒泡" },
      ],
    }),
  );
  const entGroups = ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"];
  writeFileSync(path.join(temp, "modes.json"), JSON.stringify({ entertainment: { groups: entGroups } }));
  writeFileSync(
    path.join(temp, "config.json"),
    JSON.stringify({
      onebot: { wsUrl: `ws://127.0.0.1:${address.port}`, token: "synthetic" },
      bot: { selfId: bot, nickname: "合成机器人", atAliases: ["合成机器人"], owner, whitelist: [owner], maxConcurrent: 2, timeoutMs: 15000, defaultGroup: "g1" },
      pi: { command: process.execPath, args: [path.join(here, "fixtures", "stickers-smoke-pi.mjs")], thinking: "" },
      antispam: { enabled: false },
      memory: {},
      entertainment: { replyFrequency: 1 },
    }),
  );
  child = spawn(process.execPath, [path.join(temp, "src", "main.ts")], {
    cwd: temp,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SMOKE_CALLS: callsPath },
  });
  child.stdout!.on("data", (d: Buffer) => (output += d.toString("utf8")));
  child.stderr!.on("data", (d: Buffer) => (output += d.toString("utf8")));
  await waitFor(() => !!socket, "桥接连接假 OneBot");

  // ── 主动插话：文字 + 表情包同一条发出，聊天日志带 [表情包:名称 (ID)] ──
  emit("g1", "SMOKE_PICK 吧");
  await waitFor(() => lastMessage("g1").some((s: any) => s.type === "image"), "主动插话发图");
  const first = lastMessage("g1");
  assert.equal(first[0].type, "text");
  assert.equal(first[0].data.text, "配个图");
  assert.equal(first[1].type, "image");
  assert.equal(first[1].data.file, "base64://" + HAPPY.toString("base64"));
  await waitFor(() => output.includes("[ent] 主动插话 -> 群 g1: 配个图 [表情包:开心 (happy)]"), "接话日志");
  const chatFile = path.join(temp, "memory", "group-chat", `g1-${ymd()}.jsonl`);
  await waitFor(() => existsSync(chatFile) && readFileSync(chatFile, "utf8").includes("[表情包:开心 (happy)]"), "聊天日志");
  await sleep(120);
  console.log("PASS 主动插话：文字+表情包原字节同条发送，聊天记录标注 [表情包:开心 (happy)]");

  // ── 冷却：刚发过图 60 秒内不再发图；模型只看到“本轮没有可用表情包” ──
  let beforeCalls = calls().length;
  emit("g1", "再来一张");
  await waitFor(() => calls().length > beforeCalls, "第二次接话开始");
  await waitFor(() => lastMessage("g1").every((s: any) => s.type !== "image") && sentTo("g1").length >= 2, "冷却后仅文字");
  assert.match(calls().at(-1)!.prompt, /本轮没有可用表情包/);
  await sleep(120);
  console.log("PASS 冷却：60 秒内不连发图，提示词明确本轮无可用表情包");

  // ── 被 @（娱乐模式）：走同一套协议，可只发文字 ──
  emit("g3", "SMOKE_HELLO", true);
  await waitFor(() => lastMessage("g3").some((s: any) => s.data?.text === "在呢在呢"), "@ 回复");
  assert.ok(!lastMessage("g3").some((s: any) => s.type === "image"));
  assert.match(calls().at(-1)!.prompt, /\[娱乐模式·群聊\]/);
  assert.match(calls().at(-1)!.prompt, /回复协议/);
  await sleep(120);
  console.log("PASS 被 @：娱乐模式回复同样解析协议、可选表情包");

  // ── 只 @ 不说话：提示词带上群里最近的聊天记录，模型能接着上文回 ──
  const chatDir = path.join(temp, "memory", "group-chat");
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(
    path.join(chatDir, `g2-${ymd()}.jsonl`),
    JSON.stringify({ t: new Date().toISOString(), u: "999", n: "合成群友", m: "SMOKE_BARE 这题也太难了" }) + "\n",
  );
  const beforeBare = calls().length;
  emit("g2", "", true);
  await waitFor(() => calls().length > beforeBare, "只@接话开始");
  assert.match(calls().at(-1)!.prompt, /群里最近的聊天记录/);
  assert.match(calls().at(-1)!.prompt, /合成群友: SMOKE_BARE 这题也太难了/);
  await waitFor(() => lastMessage("g2").some((s: any) => s.data?.text === "接着上文说"), "只@回复接着上文");
  await sleep(120);
  console.log("PASS 只@不说话：提示词带上最近聊天记录，回复接着上文");

  // ── 被 @ + 表情包，按群隔离冷却（新群不受 g1 冷却影响）──
  emit("g4", "SMOKE_PICK", true);
  await waitFor(() => lastMessage("g4").some((s: any) => s.type === "image"), "@ 回复带图");
  assert.equal(lastMessage("g4")[1].data.file, "base64://" + HAPPY.toString("base64"));
  await sleep(120);
  console.log("PASS 图文回复：被 @ 时也能文字+表情包一起发，冷却按群隔离");

  // ── 坏 JSON 与沉默：整条不发 ──
  beforeCalls = calls().length;
  emit("g5", "SMOKE_BAD");
  await waitFor(() => calls().length > beforeCalls && output.includes("[ent] 忽略无法解析的回复 -> 群 g5"), "坏 JSON 丢弃");
  await sleep(300);
  assert.equal(sentTo("g5").length, 0);
  beforeCalls = calls().length;
  emit("g6", "SMOKE_SILENCE");
  await waitFor(() => calls().length > beforeCalls && output.includes("[ent] 放弃插话 -> 群 g6"), "沉默不发");
  await sleep(300);
  assert.equal(sentTo("g6").length, 0);
  console.log("PASS 回退：坏 JSON 整条丢弃、沉默合法；群里都看不到任何东西");

  // ── 未知 ID 与缺文件：自动回退纯文字 ──
  emit("g7", "SMOKE_UNKNOWN");
  await waitFor(() => lastMessage("g7").some((s: any) => s.data?.text === "安全文字"), "未知 ID 回退");
  assert.ok(!lastMessage("g7").some((s: any) => s.type === "image"));
  unlinkSync(path.join(temp, "stickers", "bubble.gif"));
  beforeCalls = calls().length;
  emit("g8", "SMOKE_MISSING");
  await waitFor(() => calls().length > beforeCalls, "缺文件接话开始");
  await waitFor(() => lastMessage("g8").some((s: any) => s.data?.text === "回退吧"), "缺文件回退文字");
  assert.ok(!lastMessage("g8").some((s: any) => s.type === "image"));
  assert.doesNotMatch(calls().at(-1)!.prompt, /bubble（冒泡）/);
  await sleep(120);
  console.log("PASS 素材缺失：清单里过滤、发送前兜底，只发文字不报错");

  // ── 正常模式（未开娱乐模式的群）不受影响：不发协议、照旧卡片回复 ──
  const beforeForwards = forwards.length;
  emit("g9", "正常提问", true);
  await waitFor(() => forwards.length > beforeForwards, "正常模式卡片回复");
  assert.match(JSON.stringify(forwards.at(-1)), /咕嘎接一句/);
  assert.ok(!calls().at(-1)!.prompt.includes("回复协议"));
  await sleep(120);
  console.log("PASS 隔离：正常模式拿不到表情包协议，回复照旧");

  console.log("stickers-smoke-selftest: all passed（临时副本 + 假 OneBot + 假 pi，未连接 QQ）");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise((resolve) => child!.once("close", resolve));
    child.kill("SIGTERM");
    await closed;
  }
  for (const ws of server.clients) ws.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(temp, { recursive: true, force: true });
}
