import type { KnowledgeConfig, KnowledgeInput, Proposal, Source } from './types.ts';

export const isQQ = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{4,19}$/.test(value);
export function normalizeKnowledgeConfig(input: unknown, whitelist: string[]): KnowledgeConfig {
  const defaults: KnowledgeConfig = {
    enabled: false, groups: [], privateUsers: [], automatic: true,
    extractIntervalMs: 600000, batchMaxMessages: 80, batchMaxChars: 12000,
    maxCallsPerScopePerHour: 6, rawRetentionDays: 7,
    candidateRetentionDays: 14, retrievalMaxChars: 3000,
  };
  if (input === undefined) return defaults;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('knowledge must be an object');
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown knowledge option: ${key}`);
  for (const key of ['enabled', 'automatic'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'boolean') throw new Error(`Invalid ${key}`);
      defaults[key] = raw[key];
    }
  }
  for (const key of ['groups', 'privateUsers'] as const) {
    if (raw[key] !== undefined) {
      const list = raw[key];
      if (!Array.isArray(list) || list.length > 1000 || !list.every(isQQ) || new Set(list).size !== list.length) throw new Error(`Invalid ${key}`);
      if (key === 'privateUsers' && !list.every(id => whitelist.includes(id))) throw new Error('privateUsers must be a whitelist subset');
      defaults[key] = [...list];
    }
  }
  const ranges = {
    extractIntervalMs: [1000, 86400000], batchMaxMessages: [1, 200],
    batchMaxChars: [256, 100000], maxCallsPerScopePerHour: [1, 60],
    rawRetentionDays: [1, 365], candidateRetentionDays: [1, 365], retrievalMaxChars: [256, 20000],
  };
  for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) {
    const value = raw[key];
    if (value !== undefined) {
      const [min, max] = ranges[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
      defaults[key] = value;
    }
  }
  return defaults;
}
export function scopeOf(input: KnowledgeInput): string | undefined {
  if (!isQQ(input.userId)) return undefined;
  if (input.kind === 'private') return `private:${input.userId}`;
  if (input.kind === 'group' && isQQ(input.groupId)) return `group:${input.groupId}`;
  return undefined;
}
// Conservative heuristic, not a guarantee of detecting every secret or identifier.
export function sensitive(text: string): boolean {
  return /(?:密码|口令|密钥|身份证|护照|银行卡|私钥|助记词|证件号码|验证码|住址|病历|password|passwd|api[ _-]?key|access[ _-]?token|secret)\s*[:：=是为]?\s*\S+/i.test(text)
    || /\b(?:token|authorization|bearer)\s*[:=]\s*\S+/i.test(text)
    || /(?:sk-[a-z0-9_-]{12,}|-----BEGIN .*PRIVATE KEY-----|\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}|\b\d{17}[\dXx]\b|\b\d{16,19}\b)/i.test(text);
}
export function intent(text: string, action: string, id?: string): boolean {
  if (/(?:不要|别|不想|不需要|无需|不能|不得).{0,8}(?:记住|保存|记忆|修改|更正|纠正|忘记|删除)/.test(text)) return false;
  if (action === 'save') return /(?:请|帮我|给我|务必)?(?:记住|保存|记下|记忆一下)/.test(text);
  if (action === 'correct') return !!id && text.includes(id) && /(?:更正|纠正|修改|改成|更新)/.test(text);
  if (action === 'forget') {
    const ids = text.match(/ki_[a-f0-9]{32}/g) ?? [];
    return !!id && ids.length === 1 && ids[0] === id && /(?:忘记|删除|移除)/.test(text);
  }
  return false;
}
// Local source framing prevents a model from stripping a negating/quoted prefix, without
// letting an unrelated suggestion or negative preference elsewhere poison this proposal.
function evidenceFrame(text: string, body: string): { sentencePrefix: string; localPrefix: string; suffix: string; quoted: boolean } | undefined {
  const at = text.indexOf(body);
  if (at < 0) return;
  const before = text.slice(0, at);
  const strong = Math.max(...['。', '！', '？', '!', '?', ';', '；', '\n'].map(c => before.lastIndexOf(c))) + 1;
  const sentencePrefix = before.slice(strong);
  const weak = Math.max(sentencePrefix.lastIndexOf('，'), sentencePrefix.lastIndexOf(',')) + 1;
  const localPrefix = sentencePrefix.slice(weak);
  const after = text.slice(at + body.length);
  const end = after.search(/[，,。！？!?;；\n]/);
  const suffix = end < 0 ? after : after.slice(0, end);
  const quoted = before.lastIndexOf('“') > before.lastIndexOf('”')
    || before.lastIndexOf('「') > before.lastIndexOf('」')
    || (before.match(/"/g)?.length ?? 0) % 2 === 1
    || (before.match(/'/g)?.length ?? 0) % 2 === 1
    || (before.match(/`/g)?.length ?? 0) % 2 === 1;
  return { sentencePrefix, localPrefix, suffix, quoted };
}
export function classify(proposal: Proposal, sources: Source[]): { status: 'active' | 'candidate'; audience: 'subject_only' | 'group'; verification: string } {
  const candidate = { status: 'candidate' as const, audience: 'subject_only' as const, verification: 'unverified' };
  const body = proposal.body.trim();
  if (body.length < 4 || body.length > 2000 || sensitive(body)) return candidate;
  const supported = proposal.evidence.flatMap(e => {
    const source = sources.find(s => s.id === e.sourceId && s.text.includes(e.quote) && e.quote.includes(body));
    const frame = source && evidenceFrame(source.text, body);
    return source && frame ? [{ source, frame, quote: e.quote }] : [];
  });
  if (!supported.length) return candidate;
  for (const { source, frame, quote } of supported) {
    // Only the claimed fragment and its immediate framing determine inference/attribution.
    const unsafe = /(?:建议|推荐|也许|可能|猜测|听说|据说|引用|“|”|「|」|他(?:说|喜欢|计划|决定)|她(?:说|喜欢|计划|决定)|他们|她们|别人|其他人|忽略.{0,8}(?:规则|指令)|system\s*:|\b(?:suggest|perhaps|maybe)\b)/i;
    if (frame.quoted || unsafe.test(body) || unsafe.test(frame.localPrefix)
      || /(?:如果|假如|假设)/.test(frame.sentencePrefix)
      || /(?:如果|假如|不是|并非|绝非|没说|没有说|否认|不代表|不要把|不能说|并不(?:会|是)|\b(?:not|never)\b)/i.test(frame.localPrefix)
      || /(?:说|表示|写道|告诉我|发言)\s*[：:]\s*$/.test(frame.localPrefix)
      || /^(?:是|这)?(?:假的|谎言|错误|不是真的|不可能)/.test(frame.suffix.trim())) continue;
    // A bare fragment following someone else's advice is not the author's adoption.
    const firstPerson = /^我/.test(body);
    if (!firstPerson && /(?:他|她|别人|有人).{0,10}(?:说|建议|推荐)/.test(frame.sentencePrefix)) continue;
    if (proposal.conditions.some(c => !source.text.includes(c))) continue;
    if (proposal.kind === 'knowledge') {
      const technicalEvidence = quote.includes(body) ? quote : body;
      if (source.scope.startsWith('group:') && proposal.conditions.length > 0
        && /(?:分享给本群|本群公开)/.test(source.text)
        && /我.{0,12}(?:实测|验证)[^。！？\n]{0,200}(?:验证成功|确认解决|测试通过|复现成功)/.test(technicalEvidence)
        && !/(?:尚未|还没|并未|没有|失败|没(?:完成|解决|验证)|未(?:完成|解决|验证|确认)|不(?:能|会|是)|如果|假如)/.test(technicalEvidence)) {
        return { status: 'active', audience: 'group', verification: 'participant_confirmed' };
      }
      continue;
    }
    const implicitSelf = /(?:^|[，,：:])\s*我/.test(frame.sentencePrefix)
      && !/(?:他|她|别人|其他人).{0,8}(?:喜欢|想|会|不想|不会)/.test(frame.localPrefix);
    let own = false;
    if (proposal.kind === 'preference') {
      own = /^我(?:不)?(?:喜欢|想|偏好|习惯|愿意|希望|倾向)/.test(body)
        || (implicitSelf && /^(?:不想|不喜欢|主要想|希望|偏好|习惯)/.test(body));
    } else if (proposal.kind === 'profile') {
      own = /^我(?:不?会|正在|主要|每天|使用|是|不是|没有|还没学会)/.test(body)
        || (implicitSelf && /^(?:每天(?:能|只有|可)|主要(?:想|做|使用)|不会|不擅长)/.test(body));
    } else {
      const negativeOutcome = /(?:尚未|还没|并未|没有|不是|否认|不代表|未(?:完成|解决|确认)|没(?:完成|解决)|不(?:想|要|会|能)|建议|猜测|如果|假如)/;
      own = !negativeOutcome.test(body) && !negativeOutcome.test(frame.localPrefix)
        && /^(?:我(?:决定|确定|已完成|已经完成|就用|计划)|就用|就按|先学|决定(?:用|采用)|确定(?:用|采用))/.test(body);
    }
    if (own) return { status: 'active', audience: 'subject_only', verification: 'self_reported' };
  }
  return candidate;
}
