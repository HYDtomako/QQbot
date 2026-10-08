import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isLegacyProtected } from "../sandbox/.pi/knowledge-guard.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "qq-legacy-guard-"));
const owner = "12345", other = "23456", group = "45678", oldGroup = "56789";
const saved = Object.fromEntries(["QQ_KNOWLEDGE_PROTECTED_GROUPS", "QQ_KNOWLEDGE_PROTECTED_USERS"].map(key => [key, process.env[key]]));
const now = new Date();
const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<any> }>();
const api = { registerTool: (tool: any) => tools.set(tool.name, tool) };
try {
  const extensionDir = path.join(temp, "sandbox", ".pi", "extensions");
  mkdirSync(extensionDir, { recursive: true });
  for (const name of ["memory-tools.ts", "chat-tools.ts"]) cpSync(path.join(root, "sandbox", ".pi", "extensions", name), path.join(extensionDir, name));
  cpSync(path.join(root, "sandbox", ".pi", "knowledge-guard.ts"), path.join(temp, "sandbox", ".pi", "knowledge-guard.ts"));
  writeFileSync(path.join(temp, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(path.join(temp, "config.json"), JSON.stringify({ bot: { owner } }));
  const legacyDir = path.join(temp, "memory", "long-term");
  const chatDir = path.join(temp, "memory", "group-chat");
  mkdirSync(legacyDir, { recursive: true }); mkdirSync(chatDir, { recursive: true });
  const oldMemory = JSON.stringify({ id: "old", t: now.toISOString(), text: "合成被保护私聊资料" }) + "\n";
  writeFileSync(path.join(legacyDir, `${owner}.jsonl`), oldMemory);
  writeFileSync(path.join(legacyDir, `${other}.jsonl`), JSON.stringify({ id: "old-other", t: now.toISOString(), text: "合成未接管资料" }) + "\n");
  for (const [id, body] of [[group, "合成被保护群知识"], [oldGroup, "合成旧群记录"]]) {
    writeFileSync(path.join(chatDir, `${id}-${day}.jsonl`), JSON.stringify({ t: now.toISOString(), u: other, n: "合成用户", m: body }) + "\n");
  }
  (await import(pathToFileURL(path.join(extensionDir, "memory-tools.ts")).href)).default(api);
  (await import(pathToFileURL(path.join(extensionDir, "chat-tools.ts")).href)).default(api);
  process.env.QQ_KNOWLEDGE_PROTECTED_USERS = JSON.stringify([owner]);
  process.env.QQ_KNOWLEDGE_PROTECTED_GROUPS = JSON.stringify([group]);
  for (const action of ["remember", "recall", "forget"]) {
    const result = await tools.get(action)!.execute("test", { asker_qq: owner, text: "别写入", target: "old" });
    assert.match(result.content[0].text, /隔离记忆系统接管/);
    assert.doesNotMatch(result.content[0].text, /合成被保护私聊资料/);
  }
  assert.equal(readFileSync(path.join(legacyDir, `${owner}.jsonl`), "utf8"), oldMemory);
  console.log("PASS legacy guard: protected personal files cannot be read, changed, or deleted");
  const denied = await tools.get("chat_digest")!.execute("test", { group_id: group });
  assert.match(denied.content[0].text, /隔离记忆系统接管/);
  assert.doesNotMatch(denied.content[0].text, /合成被保护群知识/);
  const inferred = await tools.get("chat_digest")!.execute("test", {});
  assert.match(inferred.content[0].text, /合成旧群记录/);
  assert.doesNotMatch(inferred.content[0].text, /合成被保护群知识/);
  const otherMemory = await tools.get("recall")!.execute("test", { asker_qq: other });
  assert.match(otherMemory.content[0].text, /合成未接管资料/);
  console.log("PASS legacy guard: protected groups hidden from implicit selection; old scopes still work");
  process.env.QQ_KNOWLEDGE_PROTECTED_GROUPS = "invalid JSON";
  assert.equal(isLegacyProtected("group", oldGroup), true);
  assert.match((await tools.get("chat_digest")!.execute("test", { group_id: oldGroup })).content[0].text, /隔离记忆系统接管/);
  assert.match((await tools.get("chat_digest")!.execute("test", { group_id: "../private" })).content[0].text, /格式无效/);
  assert.match((await tools.get("recall")!.execute("test", { asker_qq: "../12345" })).content[0].text, /格式无效/);
  console.log("PASS legacy guard: malformed policy fails closed; invalid IDs rejected");
  console.log("legacy-guard-selftest: 3/3 passed (synthetic legacy files only)");
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(temp, { recursive: true, force: true });
}
