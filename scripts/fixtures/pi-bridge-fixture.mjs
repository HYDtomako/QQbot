import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const tools = args.includes("--tools") ? args[args.indexOf("--tools") + 1] : "";
appendFileSync(path.join(process.cwd(), "fixture-calls.jsonl"), JSON.stringify({
  tools, prompt, hasToken: !!process.env.QQ_KNOWLEDGE_TOKEN,
  hasMemoryCommandToken: !!process.env.QQ_MEMORY_CMD_TOKEN,
  session: args.includes("--session"),
  protectedGroups: JSON.parse(process.env.QQ_KNOWLEDGE_PROTECTED_GROUPS ?? "[]"),
  protectedUsers: JSON.parse(process.env.QQ_KNOWLEDGE_PROTECTED_USERS ?? "[]"),
}) + "\n");

const compactInput = prompt.match(/回复全文：\n([\s\S]*)$/);
if (compactInput) {
  // PA 回发整理：原文落盘供测试断言，并回一条干净答复（模拟模型已去掉过程细节）
  writeFileSync(path.join(process.cwd(), "last-compact-input.txt"), compactInput[1]);
  console.log("已重启，**现在生效了**，你不用动手。");
} else {
  const commandText = prompt.includes("发言者：")
    ? (prompt.split("发言者：").at(-1) ?? "").slice(0, 600)
    : prompt.slice(-600);
  const memoryCommands = ["开启记忆", "关闭记忆", "记忆状态", "退出记忆", "恢复记忆"];
  const command = memoryCommands.find((c) => commandText.includes(c));
  if (command) {
    const endpoint = process.env.QQ_MEMORY_CMD_ENDPOINT ?? "";
    const token = process.env.QQ_MEMORY_CMD_TOKEN ?? "";
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ command }),
      });
      const value = await response.json();
      console.log(typeof value.text === "string" ? value.text : "记忆命令未返回结果");
    } catch {
      console.log("记忆命令通道不可用");
    }
  } else if (/开启娱乐模式|关闭娱乐模式/.test(commandText)) {
    // 模拟模型调用 mode_manage：直接改 modes.json，桥接应热更新
    const on = commandText.includes("开启娱乐模式");
    const root = path.join(process.cwd(), "..");
    let raw = {};
    try { raw = JSON.parse(readFileSync(path.join(root, "modes.json"), "utf8")); } catch { /* 首次创建 */ }
    let groupId = "45678";
    try {
      const cfg = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8"));
      groupId = String(cfg.bot?.defaultGroup ?? groupId);
    } catch { /* 用测试默认群 */ }
    const mentioned = prompt.match(/群号\s*(\d{5,12})/);
    if (mentioned) groupId = mentioned[1];
    const current = raw?.entertainment?.groups;
    const groups = new Set(Array.isArray(current) ? current.map(String) : []);
    if (on) groups.add(groupId);
    else groups.delete(groupId);
    raw.entertainment = { ...(raw.entertainment ?? {}), groups: [...groups] };
    writeFileSync(path.join(root, "modes.json"), JSON.stringify(raw, null, 2) + "\n");
    console.log(`娱乐模式已${on ? "开启" : "关闭"}：群 ${groupId}。`);
  } else if (/旧会话不应进入/.test(prompt)) {
    console.log("BAD: OLD CONTEXT LEAK");
  } else if (/普通消息不应进入/.test(prompt) && !prompt.includes("[娱乐模式")) {
    // 娱乐模式的提示词本来就该带群聊记录（主动插话一直如此），"普通消息"出现在其中不算泄漏；
    // 这条金丝雀守的是正常模式与记忆托管路径，那两条仍然不许出现。
    console.log("BAD: OLD CONTEXT LEAK");
  } else if (prompt.includes("合成旧偏好：短句")) console.log("合成回复：私聊旧记忆可用");
  else console.log("合成回复：当前问答完成");
}
