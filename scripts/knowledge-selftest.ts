import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService } from '../src/knowledge/service.ts';
import { KnowledgeStore } from '../src/knowledge/store.ts';
import { KnowledgeWorker } from '../src/knowledge/worker.ts';
import { normalizeKnowledgeConfig } from '../src/knowledge/policy.ts';
import { validateProposals } from '../src/knowledge/extractor.ts';
import type { Item, KnowledgeInput, KnowledgeTurn, Proposal, Source } from '../src/knowledge/types.ts';

// Only isolated temporary DBs and synthetic numeric-user legacy files are touched.
const root = await mkdtemp(join(tmpdir(), 'qq-knowledge-selftest-'));
const legacy = join(root, 'legacy');
await mkdir(legacy);
const owner = '10001', a = '10002', b = '10003', g = '20001', otherGroup = '20002';
let clock = 1800000000000;
let sequence = 0;
let normal = true;
let calls = 0;
let modelMode: 'echo' | 'empty' | 'invalid' | 'wait' | 'learning' = 'echo';
let waitStarted: (() => void) | undefined;
let waitRelease: ((value: { ok: boolean; text: string }) => void) | undefined;
let heldSources: { id: string; human: string }[] = [];
const whitelist = [owner, a, b];
const config = normalizeKnowledgeConfig({ enabled: true, groups: [g, otherGroup], privateUsers: [a, b],
  extractIntervalMs: 86400000, maxCallsPerScopePerHour: 60, batchMaxChars: 12000 }, whitelist);
const input = (userId: string, text: string, groupId?: string, extras: Partial<KnowledgeInput> = {}): KnowledgeInput => ({
  kind: groupId ? 'group' : 'private', userId, ...(groupId ? { groupId } : {}), text,
  messageId: `synthetic-${++sequence}`, eventTimeMs: clock, receivedAtMs: clock,
  normal: true, addressed: !!groupId, ...extras,
});
function modelReply(sources: { id: string; human: string }[]): string {
  return JSON.stringify({ proposals: sources.filter(s => s.human.length >= 6).map(s => ({ operation: 'create',
    kind: /(?:分享给本群|本群公开)/.test(s.human) ? 'knowledge' : /建议|决定/.test(s.human) ? 'task' : 'preference',
    title: '合成测试条目', body: s.human, conditions: /SQLite 3/.test(s.human) ? ['SQLite 3'] : [],
    evidence: [{ sourceId: s.id, quote: s.human }],
  })) });
}
function learningReply(sources: { id: string; human: string }[]): string {
  const clauses: [Proposal['kind'], string][] = [
    ['profile', '我会一点 Python'], ['profile', '主要想看懂和修改开源项目'], ['profile', '每天能学半小时'],
    ['preference', '不想一开始啃厚书'], ['task', '就用 QQbot 练手'], ['task', '先学 Git 和 SQLite'],
    ['profile', '我不会 Java'], ['preference', '我不喜欢厚书'],
    ['profile', '我会 Java'], ['task', '我已完成网络作业'],
  ];
  return JSON.stringify({ proposals: sources.flatMap(s => clauses.filter(([, body]) => s.human.includes(body)).map(([kind, body]) => ({
    operation: 'create', kind, title: '学习小句', body, conditions: [], evidence: [{ sourceId: s.id, quote: s.human }],
  }))) });
}
const options = (dbPath: string, override = config) => ({ dbPath, legacyDir: legacy, config: override,
  ownerId: owner, whitelist, isNormal: () => normal, now: () => clock,
  runModel: async (prompt: string) => {
    calls++;
    const sources = JSON.parse(prompt.split('数据：')[1]) as { id: string; human: string }[];
    if (modelMode === 'wait') {
      heldSources = sources;
      return await new Promise<{ ok: boolean; text: string }>(resolve => { waitRelease = resolve; waitStarted?.(); });
    }
    return { ok: true, text: modelMode === 'empty' ? '{"proposals":[]}'
      : modelMode === 'invalid' ? '{"proposals":[],"scope":"private:10003"}'
      : modelMode === 'learning' ? learningReply(sources) : modelReply(sources) };
  },
});
let service: KnowledgeService | undefined;
let tests = 0;
async function check(name: string, test: () => Promise<void> | void): Promise<void> {
  await test(); tests++; console.log(`PASS ${name}`);
}
async function rpc(turn: KnowledgeTurn, payload: Record<string, unknown>, bearer = turn.env.QQ_KNOWLEDGE_TOKEN) {
  const response = await fetch(turn.env.QQ_KNOWLEDGE_ENDPOINT, {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, ...await response.json() as { ok: boolean; text: string } };
}
const rows = (scope?: string) => service!.store.db.prepare(`SELECT * FROM items ${scope ? 'WHERE scope=?' : ''}`)
  .all(...(scope ? [scope] : [])) as unknown as Item[];
const find = (body: string) => rows().find(i => i.body === body)!;
const drain = async () => { for (let i = 0; i < 16; i++) await service!.worker.tick(); };
async function pausedRace(user: string, text: string, group: string | undefined, mutation: (turn: KnowledgeTurn) => Promise<void> | void) {
  const turn = await service!.prepareTurn(input(user, text, group));
  assert.ok(turn.sourceId);
  modelMode = 'wait';
  const started = new Promise<void>(resolve => { waitStarted = resolve; });
  const work = service!.worker.tick();
  await started;
  await mutation(turn);
  waitRelease!({ ok: true, text: modelReply(heldSources) });
  await work;
  modelMode = 'echo'; waitStarted = undefined;
  assert.equal(rows().filter(i => i.body === text && i.status !== 'deleted').length, 0);
  return turn;
}
try {
  await check('严格配置与默认关闭', () => {
    assert.equal(normalizeKnowledgeConfig(undefined, whitelist).enabled, false);
    for (const invalid of [null, [], { unknown: true }, { enabled: 'true' }, { groups: ['../bad'] },
      { groups: [12345] }, { privateUsers: ['99999'] }, { batchMaxMessages: 0 }, { batchMaxChars: 1.5 },
      { extractIntervalMs: Number.NaN }, { retrievalMaxChars: Infinity }, { groups: [g, g] }]) {
      assert.throws(() => normalizeKnowledgeConfig(invalid, whitelist));
    }
  });
  const legacyText = [
    { id: 'old-1', t: clock - 100000, text: '我喜欢网络和计算机基础课程', pinned: true },
    { id: 'old-2', t: clock - 100000, text: '我的 API key: sk-syntheticsecret123456', pinned: true },
    { id: 'old-3', t: new Date(clock - 100000).toISOString(), text: '我习惯使用 TypeScript 编写测试' },
  ].map(x => JSON.stringify(x)).join('\n') + '\nnot-json\n';
  await writeFile(join(legacy, `${a}.jsonl`), legacyText);
  await writeFile(join(legacy, `${g}.jsonl`), JSON.stringify({ id: 'forbidden-group', t: clock, text: '群历史不许导入', pinned: true }));
  service = new KnowledgeService(options(join(root, 'main.sqlite')));
  await service.start();
  await check('初始未启用、命令 owner/normal/addressed/配置双 gate', async () => {
    assert.equal((await service!.prepareTurn(input(a, '我喜欢网络', g))).sourceId, undefined);
    assert.match((await service!.handleCommand(input(a, '开启记忆', g)))!, /owner/);
    assert.equal(await service!.handleCommand(input(owner, '开启记忆', g, { normal: false })), undefined);
    assert.equal(await service!.handleCommand(input(owner, '开启记忆', g, { addressed: false })), undefined);
    assert.match((await service!.handleCommand(input(owner, '开启记忆', '29999')))!, /配置授权/);
    assert.match((await service!.handleCommand(input(owner, '开启记忆', g)))!, /第三方模型/);
    assert.match((await service!.handleCommand(input(a, '开启记忆', undefined, { addressed: true })))!, /未经验证/);
    await service!.handleCommand(input(b, '开启记忆', undefined, { addressed: true }));
    await service!.handleCommand(input(owner, '开启记忆', otherGroup));
    assert.equal(service!.isManaged(input(a, 'x', g)), true);
  });
  await check('私聊一次性旧长期记忆导入、legacy_unverified、无群、敏感不注入', async () => {
    const imported = rows(`private:${a}`);
    assert.equal(imported.length, 2);
    assert.ok(imported.some(i => i.body === '我习惯使用 TypeScript 编写测试'), 'string t and omitted pinned must migrate');
    assert.ok(imported.every(i => i.status === 'active' && i.verification === 'legacy_unverified' && i.audience === 'subject_only'));
    assert.equal(rows().some(i => i.body.includes('群历史')), false);
    const turn = await service!.prepareTurn(input(a, '网络基础从哪里开始'));
    assert.ok(turn.env.QQ_KNOWLEDGE_TOKEN);
    assert.match(turn.contextBlock, /legacy_unverified/);
    assert.doesNotMatch(turn.contextBlock, /sk-synthetic/);
    const result = await rpc(turn, { action: 'search', query: '网络' });
    assert.ok(result.ok); assert.match(result.text, /我喜欢网络/);
    const groupTurn = await service!.prepareTurn(input(a, '网络', g));
    assert.doesNotMatch(groupTurn.contextBlock, /legacy_unverified|网络和计算机/);
    assert.doesNotMatch((await rpc(groupTurn, { action: 'search', query: '网络' })).text, /网络和计算机/);
    await service!.finishTurn(turn, { ok: true, text: '我建议学习数据库，不是用户验证' });
    await service!.finishTurn(groupTurn, { ok: true, text: '机器人建议仅上下文' });
    assert.equal(await readFile(join(legacy, `${a}.jsonl`), 'utf8'), legacyText);
    await drain();
  });
  await check('旧事件、缺事件、普通群聊、娱乐、敏感、命令与去重不采集', async () => {
    const count = () => (service!.store.db.prepare('SELECT COUNT(*) n FROM sources').get() as { n: number }).n;
    const before = count();
    for (const event of [input(a, 'old', g, { eventTimeMs: clock - 1 }), input(a, 'missing', g, { eventTimeMs: undefined }),
      input(a, 'ordinary', g, { addressed: false }), input(a, 'fun', g, { normal: false }),
      input(a, '密码: synthetic-secret', g), input(a, '身份证: 110101199001011234', g),
      input(a, 'future', g, { eventTimeMs: clock + 60001 }), input(a, '开启记忆', g)]) {
      const turn = await service!.prepareTurn(event); assert.deepEqual(turn.env, {}); assert.equal(turn.contextBlock, '');
    }
    assert.equal(count(), before);
    const event = input(a, '我喜欢数据库查询练习', g);
    const turn = await service!.prepareTurn(event);
    assert.ok(turn.sourceId);
    assert.equal((await service!.prepareTurn(event)).sourceId, undefined);
    const finished = await rpc(turn, { action: 'search', query: '网络' }); assert.ok(finished.ok);
    await service!.finishTurn(turn, { ok: false, text: '失败不存机器人回答' });
    assert.equal(service!.store.source(turn.sourceId!)!.answer, '');
    await drain();
  });
  await check('token 假冒、扩权字段、结束撤销、无意图写入、预算', async () => {
    const turn = await service!.prepareTurn(input(a, '查询数据库', g));
    assert.equal((await rpc(turn, { action: 'search', query: '网络' }, 'forged')).status, 401);
    for (const field of ['scope', 'QQ', 'group_id', 'asker_qq', 'subject', 'ownerId']) {
      assert.equal((await rpc(turn, { action: 'search', query: '数据库', [field]: b })).status, 400);
    }
    for (const action of ['save', 'correct', 'forget']) {
      const item = find('我喜欢数据库查询练习');
      const payload = action === 'save' ? { action, content: '我喜欢数据库' } : action === 'correct'
        ? { action, item_id: item.id, content: '我喜欢数据库' } : { action, item_id: item.id };
      assert.equal((await rpc(turn, payload)).status, 403);
    }
    await service!.finishTurn(turn, { ok: true, text: '回复' });
    assert.equal((await rpc(turn, { action: 'search', query: '数据库' })).status, 401);
    const budget = await service!.prepareTurn(input(a, '测试请求次数', g));
    for (let i = 0; i < 32; i++) assert.equal((await rpc(budget, { action: 'search', query: '不存在' })).status, 200);
    assert.equal((await rpc(budget, { action: 'search', query: '不存在' })).status, 429);
    await drain();
  });
  await check('同群 subject_only、跨群、私聊与 owner 不绕过', async () => {
    const text = '我喜欢在本群练习独特甲数据库';
    await service!.prepareTurn(input(a, text, g)); await drain();
    const item = find(text); assert.equal(item.status, 'active'); assert.equal(item.audience, 'subject_only');
    for (const who of [b, owner]) {
      const turn = await service!.prepareTurn(input(who, '独特甲', g));
      assert.doesNotMatch(turn.contextBlock, /独特甲数据库/);
      assert.equal((await rpc(turn, { action: 'get', item_id: item.id })).status, 404);
      assert.doesNotMatch((await rpc(turn, { action: 'search', query: '独特甲' })).text, /独特甲数据库/);
    }
    for (const turn of [await service!.prepareTurn(input(a, '独特甲', otherGroup)), await service!.prepareTurn(input(a, '独特甲'))]) {
      assert.equal((await rpc(turn, { action: 'get', item_id: item.id })).status, 404);
      assert.doesNotMatch(turn.contextBlock, /独特甲数据库/);
    }
    const own = await service!.prepareTurn(input(a, '独特甲', g));
    assert.match(own.contextBlock, /独特甲数据库/);
    assert.match((await rpc(own, { action: 'search', query: '独特甲' })).text, /独特甲数据库/);
    await drain();
  });
  await check('批量质量：建议/否定/机器人自评不激活、零产出与 schema/证据拒绝', async () => {
    const texts = ['我建议学习 SQLite 就完成任务', '我还没解决网络问题', '也许我喜欢这个计划',
      '不是说我喜欢这个提议', '我喜欢苹果但她喜欢梨', '分享给本群：我实测 SQLite 3 但是没有解决问题'];
    for (const text of texts) await service!.prepareTurn(input(a, text, g));
    await drain();
    for (const text of texts) assert.equal(find(text).status, 'candidate');
    const emptyText = '我喜欢零产出测试'; modelMode = 'empty';
    const emptyTurn = await service!.prepareTurn(input(a, emptyText, g)); await service!.worker.tick();
    assert.equal(service!.store.source(emptyTurn.sourceId!)!.processed, 1);
    assert.equal(rows().some(i => i.body === emptyText), false); modelMode = 'echo';
    const source = service!.store.source(emptyTurn.sourceId!)!;
    const valid = JSON.parse(modelReply([{ id: source.id, human: source.text }]));
    assert.throws(() => validateProposals(JSON.stringify({ ...valid, scope: `private:${b}` }), [source]));
    valid.proposals[0].subject = b;
    assert.throws(() => validateProposals(JSON.stringify(valid), [source])); delete valid.proposals[0].subject;
    valid.proposals[0].evidence[0].quote = '不存在的原文';
    assert.throws(() => validateProposals(JSON.stringify(valid), [source]));
    source.answer = '我已验证解决了，是机器人输出';
    valid.proposals[0].evidence[0].quote = source.answer;
    assert.throws(() => validateProposals(JSON.stringify(valid), [source]));
    assert.deepEqual(validateProposals('{"proposals":[]}', [source]), []);
  });
  await check('批准学习例：逐小句背景/否定偏好与无我采纳；建议、条件、否定完成不激活', async () => {
    modelMode = 'learning';
    const background = '我会一点 Python，主要想看懂和修改开源项目，每天能学半小时，不想一开始啃厚书。我建议你先学 Java。';
    await service!.prepareTurn(input(a, background, g)); await drain();
    for (const body of ['我会一点 Python', '主要想看懂和修改开源项目', '每天能学半小时', '不想一开始啃厚书']) {
      assert.equal(find(body).status, 'active', body);
      assert.equal(find(body).verification, 'self_reported');
    }
    await service!.prepareTurn(input(a, '就用 QQbot 练手，先学 Git 和 SQLite，做聊天记录查询。', g));
    await service!.prepareTurn(input(a, '我不会 Java，但我不喜欢厚书。我建议学习 SQLite，如果我会 Java就试试。也许我已完成网络作业', g));
    await service!.prepareTurn(input(b, '他建议：就用 QQbot 练手，先学 Git 和 SQLite', g));
    await drain();
    for (const body of ['就用 QQbot 练手', '先学 Git 和 SQLite', '我不会 Java', '我不喜欢厚书']) {
      assert.equal(rows(`group:${g}`).find(i => i.actor === a && i.body === body)!.status, 'active', body);
    }
    for (const body of ['就用 QQbot 练手', '先学 Git 和 SQLite']) {
      assert.equal(rows(`group:${g}`).find(i => i.actor === b && i.body === body)!.status, 'candidate', body);
    }
    assert.equal(find('我会 Java').status, 'candidate');
    assert.equal(find('我已完成网络作业').status, 'candidate');
    modelMode = 'echo';
  });
  await check('finishTurn 快速信号与30条门槛，普通问答不逐句调度', async () => {
    let scheduled = 0;
    const original = service!.worker.scheduleSoon;
    service!.worker.scheduleSoon = () => { scheduled++; };
    try {
      const signal = await service!.prepareTurn(input(b, '我会一点 FastSignal 测试'));
      await service!.finishTurn(signal, { ok: true, text: '合成回答' });
      assert.equal(scheduled, 1);
      const ordinary = await service!.prepareTurn(input(b, '普通合格闲聊消息'));
      await service!.finishTurn(ordinary, { ok: true, text: '合成回答' });
      assert.equal(scheduled, 1);
      for (let i = 0; i < 28; i++) {
        const turn = await service!.prepareTurn(input(b, `普通合格闲聊消息第${i}条`));
        await service!.finishTurn(turn, { ok: true, text: '合成回答' });
      }
      assert.equal(service!.store.pendingCount(`private:${b}`, clock, config), 30);
      assert.equal(scheduled, 2);
    } finally { service!.worker.scheduleSoon = original; }
    modelMode = 'empty'; await drain(); modelMode = 'echo';
  });
  await check('有条件本人确认经验才 public、发布者/owner更新与删除权限', async () => {
    const text = '分享给本群：我实测 SQLite 3 使用事务后验证成功并确认解决并发写入问题';
    await service!.prepareTurn(input(a, text, g)); await drain();
    const item = find(text); assert.equal(item.status, 'active'); assert.equal(item.audience, 'group');
    assert.equal(item.verification, 'participant_confirmed');
    const question = await service!.prepareTurn(input(b, 'SQLite怎么学？', g));
    assert.match(question.contextBlock, /确认解决并发写入问题/);
    for (const query of ['SQLite怎么学？', '请问 SQLite 如何学习事务？', '网络问题应该怎么查询？']) {
      const result = await rpc(question, { action: 'search', query });
      assert.ok(result.ok);
      if (query.includes('SQLite')) assert.match(result.text, /确认解决并发写入问题/);
    }
    const outside = await service!.prepareTurn(input(b, 'SQLite怎么学？', otherGroup));
    assert.doesNotMatch(outside.contextBlock, /确认解决并发写入问题/);
    assert.doesNotMatch((await rpc(outside, { action: 'search', query: 'SQLite怎么学？' })).text, /确认解决并发写入问题/);
    const turn = await service!.prepareTurn(input(b, `请修改 ${item.id} 为我喜欢别人的知识`, g));
    assert.match((await rpc(turn, { action: 'get', item_id: item.id })).text, /SQLite 3/);
    assert.equal((await rpc(turn, { action: 'correct', item_id: item.id, content: '我喜欢别人的知识' })).status, 403);
    const deletion = await service!.prepareTurn(input(b, `请删除 ${item.id}`, g));
    assert.equal((await rpc(deletion, { action: 'forget', item_id: item.id })).status, 403);
    const own = await service!.prepareTurn(input(a, `请更正 ${item.id}：分享给本群，我实测 SQLite 3 使用 WAL 后验证成功并确认解决问题`, g));
    const corrected = '分享给本群，我实测 SQLite 3 使用 WAL 后验证成功并确认解决问题';
    const result = await rpc(own, { action: 'correct', item_id: item.id, content: corrected });
    assert.ok(result.ok);
    // The genuine correction restates the existing condition and confirmed public case.
    assert.match(result.text, /已保存/);
    assert.equal(rows().find(i => i.id === item.id)!.audience, 'group');
    assert.equal(rows().find(i => i.id === item.id)!.kind, 'knowledge');
    await drain();
  });
  await check('明确保存无支持不虚假成功、否定保存拒绝', async () => {
    const turn = await service!.prepareTurn(input(a, '请记住一个待核实事项', g));
    const response = await rpc(turn, { action: 'save', content: '明天所有服务器都将完成升级' });
    assert.ok(response.ok); assert.match(response.text, /candidate/);
    assert.equal(find('明天所有服务器都将完成升级').status, 'candidate');
    const negative = await service!.prepareTurn(input(a, '不要记住这件事情', g));
    assert.equal((await rpc(negative, { action: 'save', content: '我喜欢被误解' })).status, 403);
    const direct = await service!.prepareTurn(input(a, '请记住：我使用合成环境做测试', g));
    assert.match((await rpc(direct, { action: 'save', content: '我使用合成环境做测试' })).text, /已保存/);
    await drain();
  });
  await check('FTS 中文短词、三字、特殊字符 literal、安全且隔离', async () => {
    const text = '我喜欢网络计算机以及 literal OR "quoted" * (x) NEAR : - 测试';
    await service!.prepareTurn(input(a, text, g)); await drain();
    const turn = await service!.prepareTurn(input(a, '检索特殊字符', g));
    for (const query of ['网络', '计算机', 'OR "quoted"', '*', '(x)', 'NEAR : -', '"']) {
      const result = await rpc(turn, { action: 'search', query }); assert.ok(result.ok); assert.match(result.text, /literal/);
    }
    assert.equal((await rpc(turn, { action: 'search', query: '' })).ok, true);
    const another = await service!.prepareTurn(input(b, '检索特殊字符', g));
    assert.doesNotMatch((await rpc(another, { action: 'search', query: '*' })).text, /literal/);
    await drain();
  });
  await check('近期问答仅同 actor；机器人回复不验证；总上下文预算', async () => {
    const turn = await service!.prepareTurn(input(a, '我喜欢演员甲近期上下文', g));
    await service!.finishTurn(turn, { ok: true, text: '机器人独有标记甲：我建议马上完成计划' });
    const next = await service!.prepareTurn(input(a, '上下文检查甲', g));
    assert.match(next.contextBlock, /机器人独有标记甲/);
    assert.ok(next.contextBlock.length <= config.retrievalMaxChars);
    const other = await service!.prepareTurn(input(b, '上下文检查乙', g));
    assert.doesNotMatch(other.contextBlock, /机器人独有标记甲|演员甲近期/);
    await drain();
    assert.equal(find('我喜欢演员甲近期上下文').verification, 'self_reported');
    assert.equal(rows().some(i => i.body.startsWith('机器人独有标记')), false);
  });
  await check('真实 worker CAS：人工更正获胜、模型不能猜新版本绕过批次快照', async () => {
    const item = find('我喜欢演员甲近期上下文');
    for (const guessNewVersion of [false, true]) {
      const before = rows().find(i => i.id === item.id)!;
      const body = `我喜欢独立 CAS 边界测试${guessNewVersion ? '第二轮' : '第一轮'}`;
      const turn = await service!.prepareTurn(input(a, `请更正 ${item.id}：${body}`, g));
      modelMode = 'wait'; const started = new Promise<void>(resolve => { waitStarted = resolve; });
      const work = service!.worker.tick(); await started;
      assert.match((await rpc(turn, { action: 'correct', item_id: item.id, content: body })).text, /已保存/);
      const proposal: Proposal = { operation: 'revise', targetItemId: item.id,
        expectedRevision: before.revision + (guessNewVersion ? 1 : 0), kind: 'preference',
        title: '旧worker不能覆盖', body: '我喜欢独立 CAS 边界测试', conditions: [],
        evidence: [{ sourceId: turn.sourceId!, quote: service!.store.source(turn.sourceId!)!.text }] };
      waitRelease!({ ok: true, text: JSON.stringify({ proposals: [proposal] }) }); await work;
      const current = rows().find(i => i.id === item.id)!;
      assert.equal(current.body, body); assert.equal(current.revision, before.revision + 1);
      modelMode = 'empty'; waitStarted = undefined; clock += 5000; await drain(); modelMode = 'echo';
    }
  });
  await check('删除必须唯一明确 ID、联动 wipe 与旧任务不得复活', async () => {
    const victim = find('我喜欢数据库查询练习');
    const other = find('我使用合成环境做测试');
    const ambiguous = await service!.prepareTurn(input(a, `请删除 ${victim.id} 或 ${other.id}`, g));
    assert.equal((await rpc(ambiguous, { action: 'forget', item_id: victim.id })).status, 403);
    const forgottenText = '我喜欢删除竞态特殊数据库';
    const sourceTurn = await service!.prepareTurn(input(a, `请记住：${forgottenText}`, g));
    await rpc(sourceTurn, { action: 'save', content: forgottenText });
    const item = find(forgottenText);
    modelMode = 'wait';
    const started = new Promise<void>(resolve => { waitStarted = resolve; });
    const work = service!.worker.tick(); await started;
    const deletion = await service!.prepareTurn(input(a, `请删除 ${item.id}`, g));
    assert.ok((await rpc(deletion, { action: 'forget', item_id: item.id })).ok);
    waitRelease!({ ok: true, text: modelReply(heldSources) }); await work;
    modelMode = 'echo'; waitStarted = undefined;
    assert.equal(service!.store.source(sourceTurn.sourceId!)!.text, '');
    assert.equal(service!.store.source(sourceTurn.sourceId!)!.answer, '');
    assert.equal((service!.store.db.prepare('SELECT COUNT(*) n FROM revisions WHERE item_id=?').get(item.id) as { n: number }).n, 0);
    assert.equal((service!.store.db.prepare('SELECT COUNT(*) n FROM evidence WHERE item_id=?').get(item.id) as { n: number }).n, 0);
    assert.equal((service!.store.db.prepare('SELECT COUNT(*) n FROM item_fts WHERE item_id=?').get(item.id) as { n: number }).n, 0);
    assert.equal(rows().filter(i => i.body.includes(forgottenText)).length, 0);
    await drain();
  });
  await check('撤回 tombstone，提交前撤回、重复事件及先撤回后到达不复活', async () => {
    await pausedRace(a, '我喜欢撤回竞态特殊标记', g, turn => {
      const source = service!.store.source(turn.sourceId!)!;
      service!.retract(source.scope, source.message_key);
    });
    const pre = input(a, '我喜欢先撤回的消息', g);
    service!.retract(`group:${g}`, pre.messageId!);
    assert.equal((await service!.prepareTurn(pre)).sourceId, undefined);
    await drain();
  });
  await check('退出自己的来源/worker 与 epoch，恢复不回填；同群他人不受影响', async () => {
    await pausedRace(a, '我喜欢退出竞态特殊标记', g, async turn => {
      assert.match((await service!.handleCommand(input(a, '退出记忆', g)))!, /已退出/);
      assert.equal((await rpc(turn, { action: 'search', query: '网络' })).status, 401);
    });
    assert.ok(rows(`group:${g}`).filter(i => i.actor === a).every(i => i.status === 'deleted'));
    assert.deepEqual((await service!.prepareTurn(input(a, '我喜欢退出期间', g))).env, {});
    const ownBefore = service!.store.actor(`group:${g}`, a).epoch;
    clock += 100;
    await service!.handleCommand(input(a, '恢复记忆', g));
    assert.equal(service!.store.actor(`group:${g}`, a).epoch, ownBefore + 1);
    assert.equal((await service!.prepareTurn(input(a, '我喜欢补送旧事件', g, { eventTimeMs: clock - 1 }))).sourceId, undefined);
    const fresh = await service!.prepareTurn(input(a, '我喜欢恢复后的新事件', g)); assert.ok(fresh.sourceId);
    const other = await service!.prepareTurn(input(b, '我喜欢不受甲退出影响', g)); assert.ok(other.sourceId);
    await drain();
    assert.equal(find('我喜欢恢复后的新事件').status, 'active');
    assert.equal(find('我喜欢不受甲退出影响').status, 'active');
  });
  await check('关闭持久接管、inactive不注入、重新开启 epoch 与旧 worker', async () => {
    await pausedRace(a, '我喜欢关闭竞态特殊标记', g, async () => { await service!.handleCommand(input(owner, '关闭记忆', g)); });
    assert.equal(service!.isManaged(input(a, 'still managed', g)), true);
    assert.deepEqual(await service!.prepareTurn(input(a, '我喜欢停用期间', g)), { env: {}, contextBlock: '' });
    const oldEpoch = service!.store.policy(`group:${g}`)!.epoch;
    clock += 100;
    await service!.handleCommand(input(owner, '开启记忆', g));
    assert.equal(service!.store.policy(`group:${g}`)!.epoch, oldEpoch + 1);
    assert.equal((await service!.prepareTurn(input(a, '我喜欢关闭期间补送', g, { eventTimeMs: clock - 1 }))).sourceId, undefined);
    await drain();
  });
  await check('娱乐期间后台不调用、不提交，正常恢复仅合格来源', async () => {
    const turn = await service!.prepareTurn(input(a, '我喜欢娱乐暂停测试', g));
    const before = calls; normal = false;
    await service!.worker.tick(); assert.equal(calls, before);
    assert.deepEqual((await service!.prepareTurn(input(a, '我喜欢娱乐模式消息', g))).env, {});
    normal = true;
    modelMode = 'wait'; const started = new Promise<void>(resolve => { waitStarted = resolve; });
    const work = service!.worker.tick(); await started;
    normal = false; waitRelease!({ ok: true, text: modelReply(heldSources) }); await work;
    assert.equal(rows().some(i => i.body === '我喜欢娱乐暂停测试'), false);
    normal = true; clock += 5000; modelMode = 'echo'; waitStarted = undefined;
    await drain(); assert.equal(find('我喜欢娱乐暂停测试').status, 'active');
    assert.equal(service!.store.source(turn.sourceId!)!.processed, 1);
  });
  await check('私聊 token 过期', async () => {
    const turn = await service!.prepareTurn(input(a, 'token过期检查'));
    clock += 300001;
    assert.equal((await rpc(turn, { action: 'search', query: '网络' })).status, 401);
    await drain();
  });
  await check('私聊旧导入删除后重启幂等不复活，旧文件只读', async () => {
    const old = rows(`private:${a}`).find(i => i.body === '我喜欢网络和计算机基础课程')!;
    const deletion = await service!.prepareTurn(input(a, `请删除 ${old.id}`));
    assert.ok((await rpc(deletion, { action: 'forget', item_id: old.id })).ok);
    const firstEnabled = service!.store.policy(`private:${a}`)!.first_enabled_ms;
    await service!.close(); service = new KnowledgeService(options(join(root, 'main.sqlite'))); await service.start();
    assert.equal(service.store.policy(`private:${a}`)!.first_enabled_ms, firstEnabled);
    assert.equal(rows(`private:${a}`).some(i => i.body === '我喜欢网络和计算机基础课程'), false);
    assert.equal((service.store.db.prepare('SELECT COUNT(*) n FROM legacy_imports WHERE scope=?').get(`private:${a}`) as { n: number }).n, 1);
    assert.equal(await readFile(join(legacy, `${a}.jsonl`), 'utf8'), legacyText);
    const turn = await service.prepareTurn(input(a, '网络'));
    assert.doesNotMatch((await rpc(turn, { action: 'search', query: '网络' })).text, /网络和计算机基础课程/);
  });
  await check('配置停用跨重启仍 managed、不加载历史；开启不复活旧来源', async () => {
    await service!.close();
    service = new KnowledgeService(options(join(root, 'main.sqlite'), { ...config, enabled: false })); await service.start();
    assert.equal(service.isManaged(input(a, 'check')), true);
    assert.deepEqual(await service.prepareTurn(input(a, '停用检查')), { env: {}, contextBlock: '' });
    assert.match((await service.handleCommand(input(a, '开启记忆', undefined, { addressed: true })))!, /配置授权/);
    await service.close(); service = new KnowledgeService(options(join(root, 'main.sqlite'))); await service.start();
    assert.equal(service.store.policy(`private:${a}`)!.enabled, 0);
    await service.handleCommand(input(a, '开启记忆', undefined, { addressed: true }));
  });
  await check('维护 raw expiry 与 candidate wipe，过期源不得新入库', async () => {
    await service!.handleCommand(input(b, '开启记忆', undefined, { addressed: true }));
    const turn = await service!.prepareTurn(input(b, '也许这是维护清理候选'));
    await drain(); const item = find('也许这是维护清理候选'); assert.equal(item.status, 'candidate');
    const pending = await service!.prepareTurn(input(b, '我喜欢即将过期的原文'));
    clock += 15 * 86400000;
    await service!.worker.tick();
    assert.equal(service!.store.source(turn.sourceId!)!.text, '');
    assert.equal(service!.store.source(pending.sourceId!)!.state, 'expired');
    assert.equal(rows().some(i => i.body === '我喜欢即将过期的原文'), false);
    assert.equal(rows().find(i => i.id === item.id)!.body, '');
    assert.equal(rows().find(i => i.id === item.id)!.status, 'deleted');
    assert.ok(rows(`private:${a}`).some(i => i.verification === 'legacy_unverified' && i.status === 'active'));
  });
  await check('隔离临时 store：CAS、lease过期恢复与旧持有者不得提交/取消新lease', () => {
    const store = new KnowledgeStore(join(root, 'lease.sqlite'));
    try {
      const scope = `private:${a}`;
      store.setEnabled(scope, true, clock);
      const source = store.addSource(scope, a, 'lease-source', '我喜欢独立 lease 测试', clock, clock)!;
      const job = store.claim(clock, config, () => true)!; assert.ok(job);
      assert.equal(store.claim(clock, config, () => true), undefined);
      const retry = store.claim(clock + 90001, config, () => true)!;
      assert.equal(retry.id, job.id); assert.notEqual(retry.lease_token, job.lease_token);
      assert.equal(retry.attempts, 2);
      assert.equal(store.leaseValid(job, clock + 90001, config), false);
      assert.equal(store.leaseValid(retry, clock + 90001, config), true);
      store.fail(job, clock + 90001, true);
      assert.equal(store.source(source.id)!.processed, 0);
      assert.equal(store.leaseValid(retry, clock + 90001, config), true);
      const create = validateProposals(modelReply([{ id: source.id, human: source.text }]), [source])[0];
      const item = store.tx(() => store.apply(create, [source], clock, owner))!;
      const correction = store.addSource(scope, a, 'cas-source', `请更正 ${item.id}：我喜欢独立 CAS 测试`, clock, clock)!;
      const revise: Proposal = { operation: 'revise', targetItemId: item.id, expectedRevision: 1, kind: 'preference',
        title: 'CAS测试', body: '我喜欢独立 CAS 测试', conditions: [], evidence: [{ sourceId: correction.id, quote: correction.text }] };
      assert.equal(store.tx(() => store.apply(revise, [correction], clock, owner))!.revision, 2);
      assert.equal(store.tx(() => store.apply(revise, [correction], clock, owner)), undefined);
      store.tx(() => store.forgetItem(item.id));
      assert.equal(store.tx(() => store.apply(create, [source], clock, owner)), undefined);
      assert.equal(store.leaseValid(retry, clock + 90001, config), false);
      assert.equal(store.source(source.id)!.text, '');
    } finally { store.close(); }
  });
  await check('隔离临时 store：调用预算、lease失败有限重试、批次不越 actor/字符', () => {
    const store = new KnowledgeStore(join(root, 'budget.sqlite'));
    try {
      const scope = `group:${g}`; const budgetConfig = { ...config, maxCallsPerScopePerHour: 1, batchMaxChars: 256, batchMaxMessages: 2 };
      store.setEnabled(scope, true, clock);
      store.addSource(scope, a, 'budget-a1', '我喜欢批次甲' + '甲'.repeat(100), clock, clock);
      store.addSource(scope, a, 'budget-a2', '我喜欢批次甲二' + '乙'.repeat(200), clock, clock);
      store.addSource(scope, b, 'budget-b1', '我喜欢批次乙', clock, clock);
      const job = store.claim(clock, budgetConfig, () => true)!;
      const sources = store.leaseSources(job); assert.equal(sources.length, 1); assert.equal(sources[0].actor, a);
      assert.ok(sources.reduce((n, s) => n + s.text.length + s.answer.length, 0) <= budgetConfig.batchMaxChars);
      store.fail(job, clock);
      assert.equal(store.claim(clock + 5000, budgetConfig, () => true), undefined);
      const retry = store.claim(clock + 3600001, budgetConfig, () => true)!; assert.equal(retry.attempts, 2); store.fail(retry, clock + 3600001);
      const third = store.claim(clock + 7200002, budgetConfig, () => true)!; assert.equal(third.attempts, 3); store.fail(third, clock + 7200002);
      assert.equal((store.db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id) as { state: string }).state, 'failed');
      assert.equal(store.source(sources[0].id)!.processed, -1);
      const next = store.claim(clock + 10800003, budgetConfig, () => true)!; assert.notEqual(next.id, job.id);
      const crashConfig = { ...budgetConfig, maxCallsPerScopePerHour: 60 };
      const crash2 = store.claim(clock + 10890004, crashConfig, () => true)!; assert.equal(crash2.attempts, 2);
      const crash3 = store.claim(clock + 10980005, crashConfig, () => true)!; assert.equal(crash3.attempts, 3);
      const afterCrash = store.claim(clock + 11070006, crashConfig, () => true)!;
      assert.equal((store.db.prepare('SELECT state FROM jobs WHERE id=?').get(next.id) as { state: string }).state, 'failed');
      assert.ok(afterCrash && afterCrash.id !== next.id, 'crashed final lease must not block later actor batches');
    } finally { store.close(); }
  });
  await check('AbortSignal：超时取消queued、close取消queued、旧单参数mock晚结果不提交', async () => {
    for (const mode of ['timeout', 'close', 'old-mock'] as const) {
      const store = new KnowledgeStore(':memory:');
      const scope = `private:${a}`; store.setEnabled(scope, true, clock);
      const source = store.addSource(scope, a, `abort-${mode}`, '我喜欢取消排队任务测试', clock, clock)!;
      let received: AbortSignal | undefined;
      let queued = false;
      let release: ((value: { ok: boolean; text: string }) => void) | undefined;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      const worker = new KnowledgeWorker({ store, config, ownerId: owner, allowed: () => true, isNormal: () => true,
        now: () => clock, modelTimeoutMs: 20,
        runModel: async (_prompt, signal) => {
          received = signal; queued = true; markStarted!();
          return await new Promise<{ ok: boolean; text: string }>((resolve, reject) => {
            release = resolve;
            if (mode !== 'old-mock') signal!.addEventListener('abort', () => {
              queued = false; reject(new Error('synthetic_queue_cancelled'));
            }, { once: true });
          });
        },
      });
      try {
        const work = worker.tick(); await started;
        if (mode === 'timeout') await work;
        else {
          const before = Date.now(); await worker.close();
          assert.ok(Date.now() - before < 1000, 'close must abort instead of waiting 60s');
          await work;
        }
        assert.ok(received instanceof AbortSignal); assert.equal(received!.aborted, true);
        if (mode !== 'old-mock') assert.equal(queued, false, 'cooperative runner removes queued task');
        assert.equal((store.db.prepare('SELECT state FROM jobs').get() as { state: string }).state, 'pending');
        assert.equal(store.source(source.id)!.processed, 0);
        release!({ ok: true, text: modelReply([{ id: source.id, human: source.text }]) });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal((store.db.prepare('SELECT COUNT(*) n FROM items').get() as { n: number }).n, 0);
      } finally { await worker.close(); store.close(); }
    }
  });
  await check('scheduleSoon 合并事件、无消息不调用、持久预算仍生效、close清理timer', async () => {
    const store = new KnowledgeStore(':memory:');
    const scope = `private:${a}`; store.setEnabled(scope, true, clock);
    const quickConfig = { ...config, maxCallsPerScopePerHour: 1 };
    store.addSource(scope, a, 'quick-first', '我喜欢短期快速触发测试', clock, clock);
    let invoked = 0;
    const worker = new KnowledgeWorker({ store, config: quickConfig, ownerId: owner,
      allowed: () => true, isNormal: () => true, now: () => clock, soonDelayMs: 10,
      runModel: async () => { invoked++; return { ok: true, text: '{"proposals":[]}' }; },
    });
    const delay = () => new Promise<void>(resolve => setTimeout(resolve, 60));
    try {
      worker.start();
      for (let i = 0; i < 20; i++) worker.scheduleSoon();
      assert.equal(invoked, 0); await delay(); assert.equal(invoked, 1);
      for (let i = 0; i < 20; i++) worker.scheduleSoon();
      await delay(); assert.equal(invoked, 1);
      store.addSource(scope, a, 'quick-second', '我喜欢预算限制测试', clock, clock);
      worker.scheduleSoon(); await delay(); assert.equal(invoked, 1);
      worker.scheduleSoon(); await worker.close(); await delay(); assert.equal(invoked, 1);
    } finally { await worker.close(); store.close(); }
  });
  console.log(`knowledge-selftest: ${tests} groups passed; synthetic model calls=${calls}`);
} finally {
  if (service) await service.close();
  await rm(root, { recursive: true, force: true });
}
