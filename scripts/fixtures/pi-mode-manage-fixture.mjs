/**
 * mode_manage 桥接集成测试用的“模型”。
 * 请求体里故意带上伪造的提问者和群号。
 */
const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const caseId = (prompt.match(/CASE_MODE_[A-Z0-9_]+/g)?.at(-1)) ?? "CASE_NONE";

let payload = { op: "status", asker_qq: "1", group_id: "99999" };
if (caseId === "CASE_MODE_ON") payload = { op: "on", asker_qq: "1", group_id: "99999" };
if (caseId === "CASE_MODE_SPOOF") payload = { op: "off", asker_qq: "12345", group_id: "45678" };
if (caseId === "CASE_MODE_PRIVATE") payload = { op: "on", asker_qq: "999", group_id: "45680" };

const endpoint = process.env.QQ_MODE_ENDPOINT ?? "";
const token = process.env.QQ_MODE_TOKEN ?? "";
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
