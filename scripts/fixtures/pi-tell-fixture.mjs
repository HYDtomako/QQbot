/**
 * tell_guga 桥接集成测试用的“模型”。
 * 故意在请求体里塞入提问者 QQ 和回发目标，用来确认桥接会丢掉它们。
 * 只打本机回环，不连接真实 QQ 或真实个人助手。
 */
const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const caseId = (prompt.match(/CASE_TELL_[A-Z0-9_]+/g)?.at(-1)) ?? "CASE_NONE";

let payload = { text: "默认转达", asker_qq: "1", via: "group:99999" };
if (caseId === "CASE_TELL_OK") payload = { text: "整理桌面笔记", asker_qq: "1", via: "group:99999" };
if (caseId === "CASE_TELL_SPOOF") payload = { text: "越权带话", asker_qq: "12345", via: "private:12345" };
if (caseId === "CASE_TELL_FILE") payload = { text: "改走信箱的留言", asker_qq: "12345", via: "group:1" };
if (caseId === "CASE_TELL_PRIVATE") payload = { text: "私聊转达一句", asker_qq: "999", via: "group:1" };

const endpoint = process.env.QQ_BRIDGE_ENDPOINT ?? "";
const token = process.env.QQ_BRIDGE_TOKEN ?? "";
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
