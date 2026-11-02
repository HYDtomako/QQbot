import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import taskTools from "../sandbox/.pi/extensions/task-tools.ts";
import { runTaskManage } from "../src/task-tool.ts";
import type { ScheduledTask } from "../src/tasks.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "12345";
const STRANGER = "34567";
const GROUP = "45678";
const now = new Date("2026-11-02T00:00:00.000Z");

{
  const denied = runTaskManage({
    asker: STRANGER, owner: OWNER, op: "add", name: "越权", time: "07:30",
    target: "group", groupId: GROUP, prompt: "不该建", now,
  }, []);
  assert.equal(denied.ok, false);
  assert.match(denied.text, /只有院长/);
  assert.equal(denied.next, undefined);
  const listed = runTaskManage({ asker: STRANGER, owner: OWNER, op: "list", now }, [
    { name: "已有", time: "08:00", enabled: true, target: { type: "private", id: OWNER }, prompt: "秘密" },
  ]);
  assert.equal(listed.text.includes("秘密"), false);
  assert.equal(listed.next, undefined);
  console.log("PASS privilege: 非院长不能改任务，列表也不透露内容");
}

{
  const added = runTaskManage({
    asker: OWNER, owner: OWNER, op: "add", name: "私聊提醒", time: "7:30",
    target: "private", groupId: "99999", prompt: "念课表", days: [1, 99, 3], now,
  }, []);
  assert.equal(added.ok, true);
  const task = added.next?.[0] as ScheduledTask;
  assert.equal(task.target.type, "private");
  assert.equal(task.target.id, OWNER);
  assert.equal(task.time, "07:30");
  assert.deepEqual(task.days, [1, 3]);
  assert.equal(JSON.stringify(task).includes("99999"), false);
  const grouped = runTaskManage({
    asker: OWNER, owner: OWNER, op: "add", name: "群提醒", time: "08:00",
    target: "group", groupId: GROUP, prompt: "群里说一声", now,
  }, added.next ?? []);
  assert.equal(grouped.next?.[1]?.target.id, GROUP);
  const removed = runTaskManage({
    asker: OWNER, owner: OWNER, op: "delete", name: "群提醒", now,
  }, grouped.next ?? []);
  assert.equal(removed.next?.length, 1);
  const disabled = runTaskManage({
    asker: OWNER, owner: OWNER, op: "disable", name: "私聊提醒", now,
  }, removed.next ?? []);
  assert.equal(disabled.next?.[0]?.enabled, false);
  console.log("PASS ops: 私聊目标固定是院长；群号只在 group 目标里生效");
}

const toolSrc = readFileSync(path.join(root, "sandbox", ".pi", "extensions", "task-tools.ts"), "utf8");
assert.equal(toolSrc.includes("asker_qq"), false);
assert.equal(toolSrc.includes("readFileSync"), false);
assert.equal(toolSrc.includes("writeFileSync"), false);
assert.equal(toolSrc.includes("config.json"), false);
console.log("PASS tool source: 扩展不接收提问者 QQ，也不自己改 config.json");

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
  taskTools({ registerTool(tool) { tools.push(tool as any); } });
  const tool = tools.find((item) => item.name === "task_manage");
  assert.ok(tool);
  assert.deepEqual(tool.parameters.required, ["op"]);
  assert.equal(tool.parameters.properties.asker_qq, undefined);
  const prevEndpoint = process.env.QQ_TASK_ENDPOINT;
  const prevToken = process.env.QQ_TASK_TOKEN;
  const token = "34".repeat(32);
  process.env.QQ_TASK_TOKEN = token;
  try {
    process.env.QQ_TASK_ENDPOINT = "http://evil.example/task-manage";
    const blocked = await tool.execute("1", { op: "add", asker_qq: OWNER, name: "越权" });
    assert.match(blocked.content[0].text, /没有任务管理权限/);
    assert.equal(recorded.length, 0);
    process.env.QQ_TASK_ENDPOINT = `http://127.0.0.1:${addr.port}/task-manage`;
    const sent = await tool.execute("2", {
      op: "add", asker_qq: OWNER, name: "课表", time: "07:30", target: "private",
      group_id: "99999", prompt: "念课表", days: [1, 5],
    });
    assert.equal(sent.content[0].text, "桥接已处理");
    assert.deepEqual(recorded[0].body, {
      op: "add", name: "课表", time: "07:30", target: "private",
      group_id: "99999", prompt: "念课表", days: [1, 5],
    });
    assert.equal(recorded[0].auth, `Bearer ${token}`);
    assert.equal(JSON.stringify(recorded[0].body).includes("asker_qq"), false);
    console.log("PASS tool boundary: 模型多传的提问者不会离开工具");
  } finally {
    if (prevEndpoint === undefined) delete process.env.QQ_TASK_ENDPOINT;
    else process.env.QQ_TASK_ENDPOINT = prevEndpoint;
    if (prevToken === undefined) delete process.env.QQ_TASK_TOKEN;
    else process.env.QQ_TASK_TOKEN = prevToken;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

console.log("task-manage-selftest: all passed");
