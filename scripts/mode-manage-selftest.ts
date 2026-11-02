import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import modeTools from "../sandbox/.pi/extensions/mode-tools.ts";
import { runModeManage } from "../src/mode-tool.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "12345";
const STRANGER = "34567";
const GROUP = "45678";
const OTHER = "45679";

const base = { note: "keep", entertainment: { groups: [OTHER], extra: true } };

{
  const denied = runModeManage({
    asker: STRANGER, owner: OWNER, kind: "group", sessionGroupId: GROUP,
    op: "off", groupId: GROUP,
  }, base);
  assert.equal(denied.ok, false);
  assert.match(denied.text, /只有院长/);
  assert.equal(denied.next, undefined);
  console.log("PASS privilege: 非院长不能改模式，也不生成新文件");
}

{
  const enabled = runModeManage({
    asker: OWNER, owner: OWNER, kind: "group", sessionGroupId: GROUP,
    op: "on", groupId: "99999",
  }, base);
  assert.equal(enabled.ok, true);
  assert.match(enabled.text, new RegExp(`群 ${GROUP}`));
  assert.equal(enabled.text.includes("99999"), false);
  const groups = (enabled.next?.entertainment as { groups: string[] }).groups;
  assert.deepEqual(groups, [OTHER, GROUP]);
  assert.equal(enabled.next?.note, "keep");
  console.log("PASS group: 群聊目标用会话群号，模型另报的群号被忽略");
}

{
  const named = runModeManage({
    asker: OWNER, owner: OWNER, kind: "private", defaultGroup: OTHER,
    op: "on", groupId: GROUP,
  }, { entertainment: { groups: [] } });
  assert.match(named.text, new RegExp(`群 ${GROUP}`));
  assert.deepEqual((named.next?.entertainment as { groups: string[] }).groups, [GROUP]);
  const fallback = runModeManage({
    asker: OWNER, owner: OWNER, kind: "private", defaultGroup: OTHER,
    op: "off", groupId: "",
  }, named.next ?? null);
  assert.match(fallback.text, new RegExp(`群 ${OTHER}`));
  const bad = runModeManage({
    asker: OWNER, owner: OWNER, kind: "private", op: "on", groupId: "12",
  }, null);
  assert.equal(bad.ok, false);
  assert.equal(bad.next, undefined);
  console.log("PASS private: 指定群号是业务参数，缺省用默认群，坏群号不写文件");
}

{
  const status = runModeManage({
    asker: OWNER, owner: OWNER, kind: "group", sessionGroupId: GROUP, op: "status", groupId: "1",
  }, base);
  assert.match(status.text, new RegExp(OTHER));
  assert.equal(status.next, undefined);
  const unknown = runModeManage({
    asker: OWNER, owner: OWNER, kind: "group", sessionGroupId: GROUP, op: "nope", groupId: GROUP,
  }, base);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.next, undefined);
  console.log("PASS ops: status 不写文件；未知操作拒绝");
}

const toolSrc = readFileSync(path.join(root, "sandbox", ".pi", "extensions", "mode-tools.ts"), "utf8");
assert.equal(toolSrc.includes("asker_qq"), false);
assert.equal(toolSrc.includes("readFileSync"), false);
assert.equal(toolSrc.includes("writeFileSync"), false);
assert.equal(toolSrc.includes("config.json"), false);
console.log("PASS tool source: 扩展不接收提问者 QQ，也不自己改 modes.json");

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
  modeTools({ registerTool(tool) { tools.push(tool as any); } });
  const tool = tools.find((item) => item.name === "mode_manage");
  assert.ok(tool);
  assert.deepEqual(tool.parameters.required, ["op"]);
  assert.equal(tool.parameters.properties.asker_qq, undefined);
  const prevEndpoint = process.env.QQ_MODE_ENDPOINT;
  const prevToken = process.env.QQ_MODE_TOKEN;
  const token = "cd".repeat(32);
  process.env.QQ_MODE_TOKEN = token;
  try {
    process.env.QQ_MODE_ENDPOINT = "http://evil.example/mode-manage";
    const blocked = await tool.execute("1", { op: "on", asker_qq: OWNER, group_id: "99999" });
    assert.match(blocked.content[0].text, /没有模式管理权限/);
    assert.equal(recorded.length, 0);
    process.env.QQ_MODE_ENDPOINT = `http://127.0.0.1:${addr.port}/mode-manage`;
    const sent = await tool.execute("2", { op: "on", asker_qq: OWNER, group_id: GROUP });
    assert.equal(sent.content[0].text, "桥接已处理");
    assert.deepEqual(recorded[0].body, { op: "on", group_id: GROUP });
    assert.equal(recorded[0].auth, `Bearer ${token}`);
    const status = await tool.execute("3", { op: "status", asker_qq: STRANGER });
    assert.equal(status.content[0].text, "桥接已处理");
    assert.deepEqual(recorded[1].body, { op: "status" });
    console.log("PASS tool boundary: 模型多传的提问者不会离开工具");
  } finally {
    if (prevEndpoint === undefined) delete process.env.QQ_MODE_ENDPOINT;
    else process.env.QQ_MODE_ENDPOINT = prevEndpoint;
    if (prevToken === undefined) delete process.env.QQ_MODE_TOKEN;
    else process.env.QQ_MODE_TOKEN = prevToken;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

console.log("mode-manage-selftest: all passed");
