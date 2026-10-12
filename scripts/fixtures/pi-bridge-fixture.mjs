import { appendFileSync, writeFileSync } from "node:fs";
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
const compactInput = prompt.match(/回复全文：\n([\s\S]*)$/);
if (compactInput) {
  // PA 回发整理：原文落盘供测试断言，并回一条干净答复（模拟模型已去掉过程细节）
  writeFileSync(path.join(process.cwd(), "last-compact-input.txt"), compactInput[1]);
  console.log("已重启，**现在生效了**，你不用动手。");
} else if (/旧会话不应进入|普通消息不应进入/.test(prompt)) console.log("BAD: OLD CONTEXT LEAK");
else if (prompt.includes("合成旧偏好：短句")) console.log("合成回复：私聊旧记忆可用");
else console.log("合成回复：当前问答完成");
