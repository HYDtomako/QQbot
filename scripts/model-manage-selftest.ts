import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import modelTools from "../sandbox/.pi/extensions/model-tools.ts";
import { runModelManage } from "../src/model-tool.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "12345";
const STRANGER = "34567";
const models = { test: "synthetic-public", hidden: "secret-model-id" };

{
  const denied = runModelManage({
    asker: STRANGER, owner: OWNER, op: "switch", alias: "hidden", models, current: "test",
  });
  assert.equal(denied.ok, false);
  assert.match(denied.text, /只有院长/);
  assert.equal(denied.text.includes("hidden"), false);
  assert.equal(denied.text.includes("secret-model-id"), false);
  assert.equal(denied.nextAlias, undefined);
  const listed = runModelManage({
    asker: STRANGER, owner: OWNER, op: "list", alias: "hidden", models, current: "test",
  });
  assert.equal(listed.text.includes("secret-model-id"), false);
  assert.equal(listed.nextAlias, undefined);
  console.log("PASS privilege: 非院长不能查或切模型，回复里没有模型名");
}

{
  const status = runModelManage({
    asker: OWNER, owner: OWNER, op: "status", alias: "hidden", models, defaultModel: "test", current: "test",
  });
  assert.match(status.text, /test/);
  assert.equal(status.nextAlias, undefined);
  const same = runModelManage({
    asker: OWNER, owner: OWNER, op: "switch", alias: "test", models, current: "test",
  });
  assert.match(same.text, /已经在用/);
  assert.equal(same.nextAlias, undefined);
  const switched = runModelManage({
    asker: OWNER, owner: OWNER, op: "switch", alias: "SECRET-MODEL-ID", models, current: "test",
  });
  assert.equal(switched.ok, true);
  assert.equal(switched.nextAlias, "hidden");
  const missing = runModelManage({
    asker: OWNER, owner: OWNER, op: "switch", alias: "nope", models, current: "test",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.nextAlias, undefined);
  const unknown = runModelManage({
    asker: OWNER, owner: OWNER, op: "nope", models, current: "test",
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.nextAlias, undefined);
  console.log("PASS ops: 查询不写状态；切换才给出新别名；未知模型不写");
}

const toolSrc = readFileSync(path.join(root, "sandbox", ".pi", "extensions", "model-tools.ts"), "utf8");
assert.equal(toolSrc.includes("asker_qq"), false);
assert.equal(toolSrc.includes("readFileSync"), false);
assert.equal(toolSrc.includes("writeFileSync"), false);
assert.equal(toolSrc.includes("config.json"), false);
console.log("PASS tool source: 扩展不接收提问者 QQ，也不自己改模型状态");

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
  modelTools({ registerTool(tool) { tools.push(tool as any); } });
  const tool = tools.find((item) => item.name === "model_manage");
  assert.ok(tool);
  assert.deepEqual(tool.parameters.required, ["op"]);
  assert.equal(tool.parameters.properties.asker_qq, undefined);
  const prevEndpoint = process.env.QQ_MODEL_ENDPOINT;
  const prevToken = process.env.QQ_MODEL_TOKEN;
  const token = "ab".repeat(32);
  process.env.QQ_MODEL_TOKEN = token;
  try {
    process.env.QQ_MODEL_ENDPOINT = "http://evil.example/model-manage";
    const blocked = await tool.execute("1", { op: "switch", alias: "hidden", asker_qq: OWNER });
    assert.match(blocked.content[0].text, /没有模型管理权限/);
    assert.equal(recorded.length, 0);
    process.env.QQ_MODEL_ENDPOINT = `http://127.0.0.1:${addr.port}/model-manage`;
    const sent = await tool.execute("2", { op: "switch", alias: "hidden", asker_qq: OWNER, group_id: "99999" });
    assert.equal(sent.content[0].text, "桥接已处理");
    assert.deepEqual(recorded[0].body, { op: "switch", alias: "hidden" });
    assert.equal(recorded[0].auth, `Bearer ${token}`);
    const status = await tool.execute("3", { op: "status", asker_qq: STRANGER });
    assert.deepEqual(recorded[1].body, { op: "status" });
    console.log("PASS tool boundary: 模型多传的提问者不会离开工具");
  } finally {
    if (prevEndpoint === undefined) delete process.env.QQ_MODEL_ENDPOINT;
    else process.env.QQ_MODEL_ENDPOINT = prevEndpoint;
    if (prevToken === undefined) delete process.env.QQ_MODEL_TOKEN;
    else process.env.QQ_MODEL_TOKEN = prevToken;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

console.log("model-manage-selftest: all passed");
