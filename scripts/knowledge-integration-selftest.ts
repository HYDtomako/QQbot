import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchMessage } from "../src/router.ts";
import { loadConfig } from "../src/config.ts";
import { acceptedKnowledgeInput, knowledgeContextPrompt } from "../src/knowledge/bridge.ts";
import { normalizeKnowledgeConfig } from "../src/knowledge/policy.ts";
import { KnowledgeService } from "../src/knowledge/service.ts";
import knowledgeTools from "../sandbox/.pi/extensions/knowledge-tools.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "qq-knowledge-integration-"));
const owner = "12345", other = "23456", bot = "34567", group = "45678";
let now = Math.floor(Date.now() / 1000) * 1000;
let entertainment = false;
let messageId = 0;
let passed = 0;
const whitelist = new Set([owner, other]);
const legacyDir = path.join(temp, "legacy");
mkdirSync(legacyDir);
const legacyText = JSON.stringify({ id: "old-1", t: "2026-01-01T00:00:00Z", text: "我喜欢短句回答", pinned: true }) + "\n";
writeFileSync(path.join(legacyDir, `${owner}.jsonl`), legacyText);

function event(kind: "group" | "private", user: string, text: string, at = true) {
  return {
    post_type: "message", message_type: kind, user_id: user, group_id: group,
    message_id: ++messageId, time: Math.floor(now / 1000), sender: { nickname: "合成测试用户", role: "member" },
    message: [...(kind === "group" && at ? [{ type: "at", data: { qq: bot } }] : []), { type: "text", data: { text } }],
  };
}
function input(kind: "group" | "private", text: string, user = owner) {
  now += 2000;
  const trigger = matchMessage(event(kind, user, text), bot, whitelist, ["测试机器人"]);
  assert.ok(trigger);
  return acceptedKnowledgeInput(trigger, kind === "private" || !entertainment);
}
function check(label: string, fn: () => void) {
  fn(); passed++; console.log(`ok ${passed} - ${label}`);
}
async function rpc(turn: { env: Record<string, string> }, body: object) {
  const response = await fetch(turn.env.QQ_KNOWLEDGE_ENDPOINT, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${turn.env.QQ_KNOWLEDGE_TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as { ok: boolean; text: string } };
}

const service = new KnowledgeService({
  dbPath: path.join(temp, "knowledge.sqlite"), legacyDir,
  config: normalizeKnowledgeConfig({ enabled: true, groups: [group], privateUsers: [owner, other], automatic: false }, [...whitelist]),
  ownerId: owner, whitelist: [...whitelist], isNormal: scope => !scope.startsWith("group:") || !entertainment,
  now: () => now, runModel: async () => { throw new Error("This integration test must not call a model"); },
});
try {
  await service.start();
  check("普通群聊和 @ 他人不触发", () => {
    assert.equal(matchMessage(event("group", owner, "我正在学 SQL", false), bot, whitelist, ["测试机器人"]), null);
    const e = event("group", owner, "我正在学 SQL", false);
    e.message.unshift({ type: "at", data: { qq: other } });
    assert.equal(matchMessage(e, bot, whitelist, ["测试机器人"]), null);
  });
  check("文本 @ 别名保留来源，白名单私聊不用 @", () => {
    const trigger = matchMessage(event("group", owner, "@测试机器人 我喜欢 Python", false), bot, whitelist, ["测试机器人"]);
    assert.ok(trigger);
    assert.equal(trigger.text, "我喜欢 Python");
    assert.equal(trigger.eventTimeMs, Math.floor(now / 1000) * 1000);
    assert.ok(trigger.messageId && trigger.receivedAtMs);
    assert.ok(matchMessage(event("private", owner, "hello", false), bot, whitelist, []));
    assert.equal(matchMessage(event("private", "56789", "hello", false), bot, whitelist, []), null);
  });
  assert.match((await service.handleCommand(input("group", "开启记忆", other)))!, /只有/);
  assert.match((await service.handleCommand(input("group", "开启记忆")))!, /记忆已开启/);
  assert.match((await service.handleCommand(input("private", "开启记忆")))!, /记忆已开启/);
  check("启用命令由真实身份授权，并告知第三方提炼", () => {
    assert.ok(service.isManaged(input("group", "学习路线")));
    assert.equal(readFileSync(path.join(legacyDir, `${owner}.jsonl`), "utf8"), legacyText);
    assert.ok(service.store.search(`private:${owner}`, owner, "短句").length);
    assert.equal(service.store.search(`group:${group}`, owner, "短句").length, 0);
  });
  const ownTurn = await service.prepareTurn(input("private", "我的回答偏好是什么？"));
  check("私聊接管旧记忆，标记未核实并使用受限上下文", () => {
    assert.match(ownTurn.contextBlock, /legacy_unverified/);
    assert.match(knowledgeContextPrompt(ownTurn), /未经核实/);
    assert.match(knowledgeContextPrompt(ownTurn), /不能读取旧聊天文件/);
  });
  const registered = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<any> }>();
  knowledgeTools({ registerTool: tool => registered.set(tool.name, tool) });
  check("记忆扩展没有自报 QQ 或群号参数", () => {
    assert.deepEqual([...registered.keys()], ["memory_search", "memory_get", "memory_save", "memory_correct", "memory_forget"]);
  });
  const oldEndpoint = process.env.QQ_KNOWLEDGE_ENDPOINT, oldToken = process.env.QQ_KNOWLEDGE_TOKEN;
  try {
    Object.assign(process.env, ownTurn.env);
    const result = await registered.get("memory_search")!.execute("test", { query: "短句" });
    assert.equal(result.details.ok, true);
    assert.match(result.content[0].text, /短句/);
    passed++; console.log(`ok ${passed} - 扩展通过真实本地 RPC 检索合成旧记忆`);
  } finally {
    if (oldEndpoint === undefined) delete process.env.QQ_KNOWLEDGE_ENDPOINT; else process.env.QQ_KNOWLEDGE_ENDPOINT = oldEndpoint;
    if (oldToken === undefined) delete process.env.QQ_KNOWLEDGE_TOKEN; else process.env.QQ_KNOWLEDGE_TOKEN = oldToken;
  }
  const spoof = await rpc(ownTurn, { action: "search", query: "短句", asker_qq: other });
  assert.equal(spoof.status, 400);
  await service.finishTurn(ownTurn, { ok: true, text: "合成回复" });
  const stale = await rpc(ownTurn, { action: "search", query: "短句" });
  assert.equal(stale.status, 401);
  passed++; console.log(`ok ${passed} - 扩权参数被拒绝，运行结束凭据失效`);

  const groupTurn = await service.prepareTurn(input("group", "我正在学习 Python"));
  assert.ok(groupTurn.sourceId);
  await service.finishTurn(groupTurn, { ok: true, text: "合成学习建议" });
  const later = await service.prepareTurn(input("group", "继续讨论"));
  assert.match(later.contextBlock, /合成学习建议/);
  assert.doesNotMatch(later.contextBlock, /短句回答/);
  await service.finishTurn(later, { ok: true, text: "第二轮合成回复" });
  const otherTurn = await service.prepareTurn(input("group", "我也想学习", other));
  assert.doesNotMatch(otherTurn.contextBlock, /合成学习建议|第二轮合成回复/);
  await service.finishTurn(otherTurn, { ok: true, text: "他人的合成回复" });
  passed++; console.log(`ok ${passed} - 同范围近期问答按主体隔离，不夹带私聊旧记忆`);

  entertainment = true;
  const ent = await service.prepareTurn(input("group", "我喜欢另一种回答"));
  assert.equal(ent.sourceId, undefined);
  assert.deepEqual(ent.env, {});
  entertainment = false;
  const next = await service.prepareTurn(input("group", "娱乐模式之后继续"));
  assert.doesNotMatch(next.contextBlock, /另一种回答/);
  service.retract(`group:${group}`, String(messageId));
  const revoked = await rpc(next, { action: "search", query: "Python" });
  assert.equal(revoked.status, 401);
  await service.finishTurn(next, { ok: true, text: "撤回后不应存入" });
  passed++; console.log(`ok ${passed} - 娱乐交互不采集，撤回使当前凭据与回复失效`);

  assert.match((await service.handleCommand(input("group", "关闭记忆")))!, /记忆已关闭/);
  assert.ok(service.isManaged(input("group", "关闭后仍已接管")));
  const disabled = await service.prepareTurn(input("group", "停用时的新消息"));
  assert.deepEqual(disabled, { env: {}, contextBlock: "" });
  passed++; console.log(`ok ${passed} - 关闭后不读取旧上下文、不产生采集凭据`);

  const cfgPath = path.join(temp, "config.json");
  const config = { onebot: { wsUrl: "ws://127.0.0.1:1" }, bot: { whitelist: [...whitelist] }, knowledge: { enabled: false, privateUsers: [owner] } };
  writeFileSync(cfgPath, JSON.stringify(config));
  assert.equal(loadConfig(cfgPath).knowledge?.automatic, true);
  writeFileSync(cfgPath, JSON.stringify({ ...config, knowledge: { privateUsers: ["56789"] } }));
  assert.throws(() => loadConfig(cfgPath), /whitelist/);
  writeFileSync(cfgPath, JSON.stringify({ ...config, knowledge: { importHistory: true } }));
  assert.throws(() => loadConfig(cfgPath), /Unknown/);
  const example = JSON.parse(readFileSync(path.join(root, "config.example.json"), "utf8"));
  assert.equal(example.knowledge.enabled, false);
  passed++; console.log(`ok ${passed} - 配置校验与样例默认关闭`);
  console.log(`knowledge-integration-selftest: ${passed}/${passed} passed`);
} finally {
  await service.close();
  rmSync(temp, { recursive: true, force: true });
}
