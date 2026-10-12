import { appendFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const tools = args.includes("--tools") ? args[args.indexOf("--tools") + 1] : "";
appendFileSync(path.join(process.cwd(), "fixture-calls.jsonl"), JSON.stringify({
  tools, prompt, hasToken: !!process.env.QQ_KNOWLEDGE_TOKEN,
  session: args.includes("--session"),
  protectedGroups: JSON.parse(process.env.QQ_KNOWLEDGE_PROTECTED_GROUPS ?? "[]"),
  protectedUsers: JSON.parse(process.env.QQ_KNOWLEDGE_PROTECTED_USERS ?? "[]"),
}) + "\n");
if (/旧会话不应进入|普通消息不应进入/.test(prompt)) console.log("BAD: OLD CONTEXT LEAK");
else if (prompt.includes("合成旧偏好：短句")) console.log("合成回复：私聊旧记忆可用");
else console.log("合成回复：当前问答完成");
