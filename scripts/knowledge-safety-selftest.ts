import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KnowledgeService } from "../src/knowledge/service.ts";
import { KnowledgeStore } from "../src/knowledge/store.ts";
import { normalizeKnowledgeConfig } from "../src/knowledge/policy.ts";
import type { KnowledgeInput, Proposal } from "../src/knowledge/types.ts";

const temp = mkdtempSync(path.join(os.tmpdir(), "qq-knowledge-safety-"));
const owner = "12345", publisher = "23456", observer = "34567", group = "45678";
let now = Date.now();
let seq = 0;
const scope = `group:${group}`;
const service = new KnowledgeService({
  dbPath: path.join(temp, "knowledge.sqlite"), legacyDir: path.join(temp, "legacy"),
  ownerId: owner, whitelist: [owner, publisher, observer],
  config: normalizeKnowledgeConfig({ enabled: true, groups: [group], automatic: false }, [owner, publisher, observer]),
  isNormal: () => true, now: () => now, runModel: async () => { throw new Error("No real or simulated model call needed"); },
});
function input(text: string, userId = owner): KnowledgeInput {
  now += 2000;
  return { kind: "group", groupId: group, userId, text, messageId: `safety-${++seq}`, eventTimeMs: now, receivedAtMs: now, normal: true, addressed: true };
}
async function source(text: string, userId = owner) {
  const turn = await service.prepareTurn(input(text, userId));
  assert.ok(turn.sourceId);
  assert.equal(service.isTurnCurrent(turn), true);
  await service.finishTurn(turn, { ok: true, text: "合成回复" });
  return service.store.source(turn.sourceId)!;
}
let passed = 0;
try {
  await service.start();
  await service.handleCommand(input("开启记忆"));
  const body = "我实测在 Windows 环境取消代理后验证成功，确认解决接口超时";
  const pubSource = await source(`${body}。分享给本群`, publisher);
  const pubProposal: Proposal = { operation: "create", kind: "knowledge", title: "代理排错", body, conditions: ["Windows"], evidence: [{ sourceId: pubSource.id, quote: body }] };
  const pub = service.store.tx(() => service.store.apply(pubProposal, [pubSource], now, owner));
  assert.ok(pub && pub.audience === "group" && pub.status === "active");
  for (const actor of [publisher, owner]) {
    const correction = "我喜欢先看结论";
    const s = await source(`更正 ${pub.id} ${correction}`, actor);
    const proposal: Proposal = { operation: "revise", targetItemId: pub.id, expectedRevision: pub.revision,
      kind: "profile", title: "私人偏好", body: correction, conditions: [], evidence: [{ sourceId: s.id, quote: s.text }] };
    assert.equal(service.store.tx(() => service.store.apply(proposal, [s], now, owner)), undefined);
  }
  assert.equal(service.store.getItem(pub.id, scope, observer)?.body, body);
  assert.equal(service.store.search(scope, observer, "先看结论").length, 0);
  console.log(`PASS ${++passed} - public corrections cannot become someone else's personal profile`);

  const ownBody = "我每天学习半小时";
  const s1 = await source(ownBody);
  const p1: Proposal = { operation: "create", kind: "profile", title: "学习时间", body: ownBody, conditions: [], evidence: [{ sourceId: s1.id, quote: ownBody }] };
  const item1 = service.store.tx(() => service.store.apply(p1, [s1], now, owner));
  assert.ok(item1);
  const s2 = await source(`再次说明：${ownBody}`);
  const item2 = service.store.tx(() => service.store.apply({ ...p1, title: "同一学习时间", evidence: [{ sourceId: s2.id, quote: ownBody }] }, [s2], now, owner));
  assert.equal(item2?.id, item1.id);
  assert.equal((service.store.db.prepare("SELECT COUNT(*) n FROM evidence WHERE item_id=?").get(item1.id) as { n: number }).n, 2);
  assert.equal(service.store.search(scope, observer, "半小时").length, 0);
  console.log(`PASS ${++passed} - exact duplicates reinforce sources without creating or widening items`);

  for (const text of [`如果有时间，${ownBody}`, `'${ownBody}'只是一个例句`, `\`${ownBody}\`是引用，不是自述`]) {
    const s = await source(text);
    const candidate = service.store.tx(() => service.store.apply({ ...p1, evidence: [{ sourceId: s.id, quote: ownBody }] }, [s], now, owner));
    assert.equal(candidate?.status, "candidate");
  }
  console.log(`PASS ${++passed} - conditional and quoted fragments do not become self-reported facts`);

  const columns = service.store.db.prepare("PRAGMA table_info(audit_events)").all() as { name: string }[];
  assert.ok(columns.some(c => c.name === "operation"));
  assert.ok(!columns.some(c => /body|text|quote|prompt/.test(c.name)));
  const operations = service.store.db.prepare("SELECT operation FROM audit_events").all() as { operation: string }[];
  assert.ok(operations.some(e => e.operation === "create"));
  assert.ok(operations.some(e => e.operation === "reinforce"));
  console.log(`PASS ${++passed} - audit stores operation metadata, never message bodies`);

  const pending = await service.prepareTurn(input("我想继续讨论学习时间"));
  assert.equal(service.isTurnCurrent(pending), true);
  await service.handleCommand(input("退出记忆"));
  assert.equal(service.isTurnCurrent(pending), false);
  await service.finishTurn(pending, { ok: true, text: "不应该存回的旧答案" });
  assert.equal(service.store.getItem(item1.id, scope, owner), undefined);
  assert.equal(service.store.source(pending.sourceId!)?.answer, "");
  assert.equal(service.isTurnCurrent({ env: {}, contextBlock: "" }), true);
  assert.equal(service.isTurnCurrent({ env: {}, contextBlock: "伪造历史" }), false);
  console.log(`PASS ${++passed} - revoked turns cannot publish or save answers from stale memory`);

  const futureFile = path.join(temp, "future.sqlite");
  const future = new DatabaseSync(futureFile);
  future.exec("PRAGMA user_version=2"); future.close();
  assert.throws(() => new KnowledgeStore(futureFile), /Unsupported.*schema/);
  const unchanged = new DatabaseSync(futureFile, { readOnly: true });
  assert.equal((unchanged.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
  unchanged.close();
  console.log(`PASS ${++passed} - future schemas are rejected, not silently overwritten`);
  console.log(`knowledge-safety-selftest: ${passed}/${passed} passed`);
} finally {
  await service.close();
  rmSync(temp, { recursive: true, force: true });
}
