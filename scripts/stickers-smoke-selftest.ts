import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";
import { parseEntertainmentReply } from "../src/stickers.ts";

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
  const entGroups = ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g10", "g11", "g12"];
  writeFileSync(path.join(temp, "modes.json"), JSON.stringify({ entertainment: { groups: entGroups } }));
  // 临时假 pi：在项目 fixtures 之上补三条“模型把内部标注写进 text”的回复（不动项目里的 fixtures 文件）
  const inlinePi = path.join(temp, "fixtures", "stickers-inline-pi.mjs");
  mkdirSync(path.dirname(inlinePi), { recursive: true });
  const basePi = readFileSync(path.join(here, "fixtures", "stickers-smoke-pi.mjs"), "utf8");
  const piMarker = "console.log(out);";
  assert.ok(basePi.includes(piMarker), "假 pi 结构变了，冒烟用例需要同步更新");
  writeFileSync(
    inlinePi,
    basePi.replace(
      piMarker,
      `else if (prompt.includes("SMOKE_INLINE_ID")) out = '{"text":"别以为我不会生气[表情包:反对 (happy)]","sticker":null}';\n` +
        `else if (prompt.includes("SMOKE_INLINE_FULL")) out = '{"text":"［表情包：反对（fc9593267）］算了吧","sticker":null}';\n` +
        `else if (prompt.includes("SMOKE_INLINE_NAME")) out = '{"text":"行了[表情包:开心]","sticker":null}';\n` +
        piMarker,
    ),
  );
  writeFileSync(
    path.join(temp, "config.json"),
    JSON.stringify({
      onebot: { wsUrl: `ws://127.0.0.1:${address.port}`, token: "synthetic" },
      bot: { selfId: bot, nickname: "合成机器人", atAliases: ["合成机器人"], owner, whitelist: [owner], maxConcurrent: 2, timeoutMs: 15000, defaultGroup: "g1" },
      pi: { command: process.execPath, args: [inlinePi], thinking: "" },
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

  // ── 主动插话：文字 + 表情包同一条发出，聊天日志只记人类可读的 [表情包] ──
  emit("g1", "SMOKE_PICK 吧");
  await waitFor(() => lastMessage("g1").some((s: any) => s.type === "image"), "主动插话发图");
  const first = lastMessage("g1");
  assert.equal(first[0].type, "text");
  assert.equal(first[0].data.text, "配个图");
  assert.equal(first[1].type, "image");
  assert.equal(first[1].data.file, "base64://" + HAPPY.toString("base64"));
  await waitFor(() => output.includes("[ent] 主动插话 -> 群 g1: 配个图 [表情包]"), "接话日志");
  const chatFile = path.join(temp, "memory", "group-chat", `g1-${ymd()}.jsonl`);
  await waitFor(() => existsSync(chatFile) && readFileSync(chatFile, "utf8").includes("配个图 [表情包]"), "聊天日志");
  await sleep(120);
  console.log("PASS 主动插话：文字+表情包原字节同条发送，聊天记录只标注 [表情包]（不含名称与 ID）");

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
    JSON.stringify({ t: new Date().toISOString(), u: "999", n: "合成群友", m: "SMOKE_BARE 这题也太难了 [表情包:开心 (legacy-secret-id)]", entertainment: true }) + "\n",
  );
  const beforeBare = calls().length;
  emit("g2", "", true);
  await waitFor(() => calls().length > beforeBare, "只@接话开始");
  assert.match(calls().at(-1)!.prompt, /群里最近的聊天记录/);
  assert.match(calls().at(-1)!.prompt, /合成群友（QQ 999）: SMOKE_BARE 这题也太难了 \[表情包\]/);
  assert.doesNotMatch(calls().at(-1)!.prompt, /legacy-secret-id/);
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

  // ── 模型把内部标注写进 text：剥离标注，按 ID 命中候选才发图，绝不把标注发进群 ──
  const msgsTo = (gid: string) => sentTo(gid).map((r) => r.params.message as any[]);
  emit("g10", "SMOKE_INLINE_ID", true);
  await waitFor(() => msgsTo("g10").some((m) => m.some((s) => s.type === "image")), "内联标注命中候选后发图");
  const inline = msgsTo("g10").find((m) => m.some((s) => s.type === "image"))!;
  assert.deepEqual(inline.map((s) => s.type), ["text", "image"]);
  assert.equal(inline[0].data.text, "别以为我不会生气"); // 标注（名称与 id 不一致）已剥离，按 id 选中 happy
  assert.equal(inline[1].data.file, "base64://" + HAPPY.toString("base64"));
  assert.ok(!JSON.stringify(msgsTo("g10")).includes("表情包"), "群消息里不能出现内部标注");

  emit("g11", "SMOKE_INLINE_FULL", true);
  await waitFor(() => msgsTo("g11").some((m) => m.some((s) => s.data?.text === "算了吧")), "全角标注且 id 不在候选：剥净只发文字");
  assert.ok(!msgsTo("g11").some((m) => m.some((s) => s.type === "image")));
  assert.ok(!JSON.stringify(msgsTo("g11")).includes("表情包"), "全角标注同样不能发进群");

  emit("g12", "SMOKE_INLINE_NAME", true);
  await waitFor(() => msgsTo("g12").some((m) => m.some((s) => s.data?.text === "行了")), "只有名称：剥掉标注不强行选图");
  assert.ok(!msgsTo("g12").some((m) => m.some((s) => s.type === "image")));
  await sleep(120);
  console.log("PASS 内联标注兜底：text 洗成纯文本，命中候选才选图，全角/半角/只有名称都不把标注发进群");

  // ── 正常模式（未开娱乐模式的群）不受影响：不发协议、照旧卡片回复 ──
  const beforeForwards = forwards.length;
  emit("g9", "正常提问", true);
  await waitFor(() => forwards.length > beforeForwards, "正常模式卡片回复");
  assert.match(JSON.stringify(forwards.at(-1)), /咕嘎接一句/);
  assert.ok(!calls().at(-1)!.prompt.includes("回复协议"));
  await sleep(120);
  console.log("PASS 隔离：正常模式拿不到表情包协议，回复照旧");

  // ── 兜底解析矩阵（直接测 src 源码，覆盖半角/全角、命中/不命中候选、只有名称）──
  const cand = [{ id: "happy" }, { id: "bubble" }];
  const clean = (raw: string) => {
    const r = parseEntertainmentReply(raw, cand);
    assert.ok(r.valid);
    assert.doesNotMatch(r.text, /表情包|[\[［【]/, "text 不能残留内部标注");
    return r;
  };
  // 半角标注 + 命中候选：text 洗成纯文本，sticker 取标注里的 ID（名称与 ID 不一致也按 ID 走）
  assert.deepEqual(clean('{"text":"别以为我不会生气[表情包:反对 (happy)]","sticker":null}'), {
    valid: true,
    text: "别以为我不会生气",
    sticker: "happy",
  });
  assert.deepEqual(clean('{"text":"哈[表情包:反对 (happy)]"}'), { valid: true, text: "哈", sticker: "happy" }); // sticker 字段缺失
  // 全角括号 + 中文冒号
  assert.deepEqual(clean('{"text":"［表情包：反对（bubble）］真服了","sticker":null}'), {
    valid: true,
    text: "真服了",
    sticker: "bubble",
  });
  // 纯文本回复（没有 JSON）里的标注
  assert.deepEqual(clean("算了吧[表情包：反对(happy)]"), { valid: true, text: "算了吧", sticker: "happy" });
  // id 不在候选：剥净 text，sticker 保持 null
  assert.deepEqual(clean('{"text":"别以为我不会生气[表情包:反对 (fc9593267)]","sticker":null}'), {
    valid: true,
    text: "别以为我不会生气",
    sticker: null,
  });
  assert.deepEqual(clean("算了[表情包:反对 (nope)]"), { valid: true, text: "算了", sticker: null });
  assert.deepEqual(clean("再不听话就生气了[表情包:反对 (fc9593267)]"), {
    valid: true,
    text: "再不听话就生气了",
    sticker: null,
  });
  // 只有名称、没有 id：只剥标注，不强行选图
  assert.deepEqual(clean('{"text":"行了[表情包:开心]","sticker":null}'), { valid: true, text: "行了", sticker: null });
  // 协议字段优先：text 照样洗，sticker 用字段里的值
  assert.deepEqual(clean('{"text":"配图[表情包:反对 (bubble)]","sticker":"happy"}'), {
    valid: true,
    text: "配图",
    sticker: "happy",
  });
  // 没有标注时一个字都不动（原有行为不回归）
  assert.deepEqual(parseEntertainmentReply("随便聊两句", cand), { valid: true, text: "随便聊两句", sticker: null });
  assert.equal(parseEntertainmentReply('{"text":"', cand).valid, false);
  console.log("PASS 兜底解析：半角/全角标注都剥净，按 ID 命中候选才选图，只有名称不发图，纯文本不动");

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
