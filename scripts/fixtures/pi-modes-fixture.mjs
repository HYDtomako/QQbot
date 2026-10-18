import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const session = args.includes("--session") ? args[args.indexOf("--session") + 1] : "";
const previous = session && existsSync(session) ? readFileSync(session, "utf8") : "";
const summary = prompt.startsWith("请把这段对话压缩");
const commandText = prompt.includes("发言者：")
  ? (prompt.split("发言者：").at(-1) ?? "").slice(0, 600)
  : prompt.slice(-600);

if (/开启娱乐模式|关闭娱乐模式/.test(commandText)) {
  const on = commandText.includes("开启娱乐模式");
  const endpoint = process.env.QQ_MODE_CMD_ENDPOINT ?? "";
  const token = process.env.QQ_MODE_CMD_TOKEN ?? "";
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ op: on ? "on" : "off" }),
    });
    const value = await response.json();
    console.log(typeof value.text === "string" ? value.text : "模式命令未返回结果");
  } catch {
    console.log("模式命令通道不可用");
  }
} else {
  const key = summary && previous.includes("HOLD_SUMMARY_FIXTURE") ? "CASE_SUMMARY_HOLD" : (prompt.match(/CASE_[A-Z0-9_]+/g)?.at(-1) ?? "CASE_UNKNOWN");
  const entertainment = prompt.includes("[娱乐模式·");
  appendFileSync(path.join(process.cwd(), "mode-calls.jsonl"), JSON.stringify({ key, prompt, session, entertainment, previous, noTools: args.includes("--no-tools") }) + "\n");
  if (session) appendFileSync(session, JSON.stringify({ role: "user", text: prompt }) + "\n");
  if (key.includes("HOLD")) {
    const release = path.join(process.cwd(), `release-${key}`);
    while (!existsSync(release)) await new Promise(resolve => setTimeout(resolve, 20));
  }
  let raw = `answer:${key}`;
  if (summary) raw = "合成同模式摘要";
  else if (key === "CASE_LEAK") raw = JSON.stringify({ text: "已处理", sticker: "happy" });
  else if (key === "CASE_EMPTY") raw = JSON.stringify({ text: "", sticker: null });
  else if (key === "CASE_LITERAL") raw = JSON.stringify({ text: "字面示例", sticker: null });
  else if (key === "CASE_BUSINESS_JSON") raw = JSON.stringify({ status: "ok", data: { count: 2 } });
  else if (entertainment) raw = JSON.stringify({ text: raw, sticker: ["CASE_ENT_IMAGE", "CASE_ENT_FALLBACK"].includes(key) ? "happy" : null });
  if (session) appendFileSync(session, JSON.stringify({ role: "assistant", text: raw }) + "\n");
  console.log(raw);
}
