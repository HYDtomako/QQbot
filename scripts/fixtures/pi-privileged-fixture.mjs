/**
 * model_manage / send_group_message / 记忆 / task_manage 的桥接集成测试用“模型”。
 * 请求体里故意带上伪造的提问者 QQ。桥接必须按本轮 OneBot 会话处理，而不是按这个字段。
 */
const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const caseId = (prompt.match(/CASE_(?:MODEL|SEND|MEM|TASK)_[A-Z0-9_]+/g)?.at(-1)) ?? "CASE_NONE";

const routes = {
  MODEL: [process.env.QQ_MODEL_ENDPOINT ?? "", process.env.QQ_MODEL_TOKEN ?? ""],
  SEND: [process.env.QQ_SEND_ENDPOINT ?? "", process.env.QQ_SEND_TOKEN ?? ""],
  MEM: [process.env.QQ_MEMORY_ENDPOINT ?? "", process.env.QQ_MEMORY_TOKEN ?? ""],
  TASK: [process.env.QQ_TASK_ENDPOINT ?? "", process.env.QQ_TASK_TOKEN ?? ""],
};

let kind = "MODEL";
let payload = { op: "status", asker_qq: "12345" };
if (caseId === "CASE_MODEL_SPOOF") payload = { op: "switch", alias: "hidden", asker_qq: "12345" };
if (caseId === "CASE_MODEL_STATUS") payload = { op: "status", asker_qq: "12345" };
if (caseId === "CASE_MODEL_OK") payload = { op: "switch", alias: "hidden", asker_qq: "1" };
if (caseId === "CASE_SEND_SPOOF") {
  kind = "SEND";
  payload = { text: "不该发出去", group_id: "99999", asker_qq: "12345" };
}
if (caseId === "CASE_SEND_OK") {
  kind = "SEND";
  payload = { text: "群通知正文甲", group_id: "45678", asker_qq: "1" };
}
if (caseId === "CASE_MEM_OK") {
  kind = "MEM";
  payload = { op: "remember", text: "MEMTOKEN9527", asker_qq: "1" };
}
if (caseId === "CASE_MEM_RECALL") {
  kind = "MEM";
  payload = { op: "recall", query: "MEMTOKEN9527", asker_qq: "12345" };
}
if (caseId === "CASE_MEM_SPOOF") {
  kind = "MEM";
  payload = { op: "remember", text: "SPOOFMEM777", asker_qq: "12345" };
}
if (caseId === "CASE_TASK_SPOOF") {
  kind = "TASK";
  payload = { op: "add", name: "越权任务", time: "07:30", target: "group", group_id: "99999", prompt: "不该建", asker_qq: "12345" };
}
if (caseId === "CASE_TASK_OK") {
  kind = "TASK";
  payload = { op: "add", name: "课表提醒", time: "07:30", target: "private", group_id: "99999", prompt: "念课表", asker_qq: "999" };
}

const [endpoint, token] = routes[kind];
let out = "answer";
try {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const value = await response.json();
  out = `RESULT ${typeof value.text === "string" ? value.text : "no-text"}`;
} catch (err) {
  out = `RESULT endpoint-error ${err instanceof Error ? err.message : String(err)}`;
}
console.log(out);
