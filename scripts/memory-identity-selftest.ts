import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import memoryTools from "../sandbox/.pi/extensions/memory-tools.ts";
import { loadMemory, memoryFile, runMemory } from "../src/memory-tool.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "12345";
const STRANGER = "34567";
const dir = mkdtempSync(path.join(tmpdir(), "qqbot-memory-"));
const now = () => new Date("2026-11-02T00:00:00.000Z");
let seq = 0;
const id = () => `id${++seq}`;

try {
  const denied = runMemory({
    asker: STRANGER, owner: OWNER, op: "remember", text: "伪造的院长秘密", now, id,
  }, dir);
  assert.match(denied.text, /只有院长/);
  assert.equal(loadMemory(dir, OWNER).length, 0);
  assert.equal(loadMemory(dir, STRANGER).length, 0);
  console.log("PASS remember: 非院长写不进任何人的档案");

  const remembered = runMemory({
    asker: OWNER, owner: OWNER, op: "remember", text: "学号是 9527", now, id,
  }, dir);
  assert.match(remembered.text, /已记住/);
  assert.equal(loadMemory(dir, OWNER)[0]?.pinned, true);
  assert.equal(loadMemory(dir, STRANGER).length, 0);

  const recalled = runMemory({
    asker: STRANGER, owner: OWNER, op: "recall", query: "9527",
  }, dir);
  assert.match(recalled.text, /还没有任何条目/);
  assert.equal(recalled.text.includes("9527"), false);
  const own = runMemory({ asker: OWNER, owner: OWNER, op: "recall" }, dir);
  assert.match(own.text, /9527/);
  console.log("PASS recall: 只能打开本轮提问者自己的档案");

  const forgotten = runMemory({
    asker: STRANGER, owner: OWNER, op: "forget", target: "9527",
  }, dir);
  assert.match(forgotten.text, /只有院长/);
  assert.equal(loadMemory(dir, OWNER).length, 1);
  const removed = runMemory({
    asker: OWNER, owner: OWNER, op: "forget", target: "9527",
  }, dir);
  assert.match(removed.text, /已删除/);
  assert.equal(loadMemory(dir, OWNER).length, 0);
  console.log("PASS forget: 非院长删不掉，院长只能删自己的");

  const bad = runMemory({ asker: "12", owner: OWNER, op: "recall" }, dir);
  assert.match(bad.text, /QQ 号格式无效/);
  assert.equal(memoryFile(dir, OWNER).endsWith(`${OWNER}.jsonl`), true);
  console.log("PASS guard: 坏 QQ 不落 unknown 档案");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const toolSrc = readFileSync(path.join(root, "sandbox", ".pi", "extensions", "memory-tools.ts"), "utf8");
assert.equal(toolSrc.includes("asker_qq"), false);
assert.equal(toolSrc.includes("readFileSync"), false);
assert.equal(toolSrc.includes("writeFileSync"), false);
assert.equal(toolSrc.includes("config.json"), false);
console.log("PASS tool source: 扩展不接收提问者 QQ，也不自己读写记忆文件");

{
  const recorded: Array<{ body: any; auth: string }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += String(chunk); });
    req.on("end", () => {
      recorded.push({ body: JSON.parse(raw), auth: String(req.headers.authorization ?? "") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, text: "桥接已处理" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const tools: Array<{ name: string; parameters: any; execute: (id: string, params: Record<string, unknown>) => Promise<any> }> = [];
  memoryTools({ registerTool(tool) { tools.push(tool as any); } });
  const remember = tools.find((item) => item.name === "remember");
  const recall = tools.find((item) => item.name === "recall");
  const forget = tools.find((item) => item.name === "forget");
  assert.ok(remember && recall && forget);
  assert.equal(remember.parameters.properties.asker_qq, undefined);
  assert.equal(recall.parameters.properties.asker_qq, undefined);
  assert.equal(forget.parameters.properties.asker_qq, undefined);
  const prevEndpoint = process.env.QQ_MEMORY_ENDPOINT;
  const prevToken = process.env.QQ_MEMORY_TOKEN;
  const token = "12".repeat(32);
  process.env.QQ_MEMORY_TOKEN = token;
  try {
    process.env.QQ_MEMORY_ENDPOINT = "http://evil.example/memory";
    const blocked = await remember.execute("1", { text: "不该写", asker_qq: OWNER, pinned: true });
    assert.match(blocked.content[0].text, /没有记忆权限/);
    assert.equal(recorded.length, 0);
    process.env.QQ_MEMORY_ENDPOINT = `http://127.0.0.1:${addr.port}/memory`;
    await remember.execute("2", { text: "只记这句", asker_qq: OWNER, pinned: true });
    assert.deepEqual(recorded[0].body, { op: "remember", text: "只记这句", pinned: true });
    assert.equal(recorded[0].auth, `Bearer ${token}`);
    await recall.execute("3", { query: "这句", asker_qq: STRANGER });
    assert.deepEqual(recorded[1].body, { op: "recall", query: "这句" });
    await forget.execute("4", { target: "这句", asker_qq: OWNER });
    assert.deepEqual(recorded[2].body, { op: "forget", target: "这句" });
    console.log("PASS tool boundary: 三个记忆工具都不会把提问者带出本进程");
  } finally {
    if (prevEndpoint === undefined) delete process.env.QQ_MEMORY_ENDPOINT;
    else process.env.QQ_MEMORY_ENDPOINT = prevEndpoint;
    if (prevToken === undefined) delete process.env.QQ_MEMORY_TOKEN;
    else process.env.QQ_MEMORY_TOKEN = prevToken;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

console.log("memory-identity-selftest: all passed");
