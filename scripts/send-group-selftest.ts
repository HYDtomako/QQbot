import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sendTools from "../sandbox/.pi/extensions/send-tools.ts";
import { runSendGroup, SEND_MAX_CHARS } from "../src/send-tool.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "12345";
const STRANGER = "34567";
const GROUP = "45678";
const OTHER = "45679";

{
  const denied = runSendGroup({
    asker: STRANGER, owner: OWNER, text: "不该发出去", groupId: GROUP, defaultGroup: OTHER,
  });
  assert.equal(denied.ok, false);
  assert.match(denied.text, /只有院长/);
  assert.equal(denied.message, undefined);
  assert.equal(denied.text.includes("不该发出去"), false);
  console.log("PASS privilege: 非院长不能发群，也不生成发件箱记录");
}

{
  const named = runSendGroup({
    asker: OWNER, owner: OWNER, text: " 群通知正文 ", groupId: GROUP, defaultGroup: OTHER,
  });
  assert.equal(named.ok, true);
  assert.deepEqual(named.message, { group_id: GROUP, text: "群通知正文" });
  const fallback = runSendGroup({
    asker: OWNER, owner: OWNER, text: "走默认群", groupId: "", defaultGroup: OTHER,
  });
  assert.equal(fallback.message?.group_id, OTHER);
  const missing = runSendGroup({
    asker: OWNER, owner: OWNER, text: "没地方发", groupId: "  ", defaultGroup: "",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.message, undefined);
  const empty = runSendGroup({ asker: OWNER, owner: OWNER, text: "  ", groupId: GROUP });
  assert.equal(empty.message, undefined);
  const huge = runSendGroup({
    asker: OWNER, owner: OWNER, text: "字".repeat(SEND_MAX_CHARS + 1), groupId: GROUP,
  });
  assert.equal(huge.ok, false);
  assert.equal(huge.message, undefined);
  console.log("PASS payload: 指定群号是业务参数，缺省用默认群，空内容和超长不入队");
}

const toolSrc = readFileSync(path.join(root, "sandbox", ".pi", "extensions", "send-tools.ts"), "utf8");
assert.equal(toolSrc.includes("asker_qq"), false);
assert.equal(toolSrc.includes("readFileSync"), false);
assert.equal(toolSrc.includes("writeFileSync"), false);
assert.equal(toolSrc.includes("appendFileSync"), false);
assert.equal(toolSrc.includes("config.json"), false);
assert.equal(toolSrc.includes("outbox"), false);
console.log("PASS tool source: 扩展不接收提问者 QQ，也不自己写发件箱");

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
  sendTools({ registerTool(tool) { tools.push(tool as any); } });
  const tool = tools.find((item) => item.name === "send_group_message");
  assert.ok(tool);
  assert.deepEqual(tool.parameters.required, ["text"]);
  assert.equal(tool.parameters.properties.asker_qq, undefined);
  const prevEndpoint = process.env.QQ_SEND_ENDPOINT;
  const prevToken = process.env.QQ_SEND_TOKEN;
  const token = "ef".repeat(32);
  process.env.QQ_SEND_TOKEN = token;
  try {
    process.env.QQ_SEND_ENDPOINT = "http://evil.example/send-group";
    const blocked = await tool.execute("1", { text: "不该出去", asker_qq: OWNER, group_id: "99999" });
    assert.match(blocked.content[0].text, /没有发群权限/);
    assert.equal(recorded.length, 0);
    process.env.QQ_SEND_ENDPOINT = `http://127.0.0.1:${addr.port}/send-group`;
    const sent = await tool.execute("2", { text: "只发这句", asker_qq: OWNER, group_id: GROUP });
    assert.equal(sent.content[0].text, "桥接已处理");
    assert.deepEqual(recorded[0].body, { text: "只发这句", group_id: GROUP });
    assert.equal(recorded[0].auth, `Bearer ${token}`);
    const fallback = await tool.execute("3", { text: "默认群", asker_qq: STRANGER });
    assert.deepEqual(recorded[1].body, { text: "默认群" });
    console.log("PASS tool boundary: 模型多传的提问者不会离开工具");
  } finally {
    if (prevEndpoint === undefined) delete process.env.QQ_SEND_ENDPOINT;
    else process.env.QQ_SEND_ENDPOINT = prevEndpoint;
    if (prevToken === undefined) delete process.env.QQ_SEND_TOKEN;
    else process.env.QQ_SEND_TOKEN = prevToken;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

console.log("send-group-selftest: all passed");
