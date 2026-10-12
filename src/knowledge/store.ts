import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ActorPolicy, Item, KnowledgeConfig, Lease, Proposal, ScopePolicy, Source } from './types.ts';
import { classify, intent, sensitive } from './policy.ts';

export const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const DAY = 86400000;
// Bounded literal terms, never caller-supplied MATCH operators. Keep the complete query
// for exact/special-character matches, then remove common question scaffolding.
export function queryTerms(query: string): string[] {
  const terms = [query];
  const add = (term: string) => {
    term = term.trim();
    if (term.length >= 2 && term.length <= 64 && !terms.includes(term) && terms.length < 8) terms.push(term);
  };
  for (const word of query.match(/[A-Za-z][A-Za-z0-9_.+#-]{0,31}/g) ?? []) add(word);
  const chinese = query.replace(/(?:请问|告诉我|帮我|想了解|想知道|怎么样|怎么学|怎么|如何|怎样|为什么|是什么|什么是|是什么|哪些|哪里|哪种|能否|是否|有没有|可以|相关|关于|查询|搜索|检索|学习|请|什么|吗|呢|呀|啊|的|了|学)/g, ' ');
  const runs = chinese.match(/[\u3400-\u9fff]+/g) ?? [];
  for (const word of runs) add(word);
  // Long unsegmented Chinese questions receive a few short-word recall paths as a fallback.
  for (const word of runs) {
    if (word.length < 4) continue;
    for (let i = 0; i + 2 <= word.length && terms.length < 8; i += 2) add(word.slice(i, i + 2));
  }
  return terms.slice(0, 8);
}
export class KnowledgeStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) { this.db.close(); throw new Error('Unsupported knowledge schema version'); }
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS scope_policies (
        scope TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, ever_enabled INTEGER NOT NULL DEFAULT 0,
        first_enabled_ms INTEGER NOT NULL DEFAULT 0, enabled_ms INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS actor_policies (
        scope TEXT NOT NULL, actor TEXT NOT NULL, opted_out INTEGER NOT NULL DEFAULT 0,
        epoch INTEGER NOT NULL DEFAULT 0, enabled_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope, actor));
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, actor TEXT NOT NULL, message_key TEXT NOT NULL,
        text TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', event_ms INTEGER NOT NULL,
        created_ms INTEGER NOT NULL, epoch INTEGER NOT NULL, actor_epoch INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'live', processed INTEGER NOT NULL DEFAULT 0,
        UNIQUE(scope, message_key));
      CREATE INDEX IF NOT EXISTS source_pending ON sources(scope, actor, processed, state, created_ms);
      CREATE TABLE IF NOT EXISTS message_tombstones (scope TEXT NOT NULL, message_key TEXT NOT NULL, PRIMARY KEY(scope, message_key));
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, actor TEXT NOT NULL, audience TEXT NOT NULL,
        kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, conditions TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, verification TEXT NOT NULL,
        created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, origin_key TEXT NOT NULL UNIQUE);
      CREATE INDEX IF NOT EXISTS item_scope ON items(scope, status, actor, audience);
      CREATE TABLE IF NOT EXISTS revisions (
        item_id TEXT NOT NULL REFERENCES items(id), revision INTEGER NOT NULL, title TEXT NOT NULL,
        body TEXT NOT NULL, conditions TEXT NOT NULL, verification TEXT NOT NULL, created_ms INTEGER NOT NULL,
        PRIMARY KEY(item_id, revision));
      CREATE TABLE IF NOT EXISTS evidence (
        item_id TEXT NOT NULL REFERENCES items(id), revision INTEGER NOT NULL,
        source_id TEXT NOT NULL REFERENCES sources(id), source_version INTEGER NOT NULL,
        quote TEXT NOT NULL, PRIMARY KEY(item_id, revision, source_id));
      CREATE VIRTUAL TABLE IF NOT EXISTS item_fts USING fts5(item_id UNINDEXED, body, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, actor TEXT NOT NULL, epoch INTEGER NOT NULL,
        actor_epoch INTEGER NOT NULL, sources TEXT NOT NULL, item_versions TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'pending',
        lease_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT NOT NULL DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 0, retry_ms INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS job_scope ON jobs(scope, actor, state);
      CREATE TABLE IF NOT EXISTS model_calls (scope TEXT NOT NULL, called_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS model_calls_time ON model_calls(scope, called_ms);
      CREATE TABLE IF NOT EXISTS legacy_imports (scope TEXT PRIMARY KEY, completed_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY, operation TEXT NOT NULL, item_id TEXT, scope TEXT NOT NULL, created_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_time ON audit_events(created_ms);
    `);
    if (version === 0) this.db.exec('PRAGMA user_version=1');
    // Remove deleted FTS terms from index segments as well as the visible content table.
    this.db.prepare("INSERT INTO item_fts(item_fts,rank) VALUES ('secure-delete',1)").run();
  }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private audit(operation: string, scope: string, now: number, itemId?: string): void {
    this.db.prepare('INSERT INTO audit_events(operation,item_id,scope,created_ms) VALUES (?,?,?,?)')
      .run(operation, itemId ?? null, scope, now);
  }
  policy(scope: string): ScopePolicy | undefined {
    return this.db.prepare('SELECT * FROM scope_policies WHERE scope=?').get(scope) as unknown as ScopePolicy | undefined;
  }
  ensurePolicy(scope: string): ScopePolicy {
    this.db.prepare('INSERT OR IGNORE INTO scope_policies(scope) VALUES (?)').run(scope);
    return this.policy(scope)!;
  }
  setEnabled(scope: string, enabled: boolean, now: number): ScopePolicy {
    this.ensurePolicy(scope);
    this.db.prepare(`UPDATE scope_policies SET enabled=?, ever_enabled=MAX(ever_enabled,?),
      first_enabled_ms=CASE WHEN ever_enabled=0 AND ?=1 THEN ? ELSE first_enabled_ms END,
      enabled_ms=?, epoch=epoch+1 WHERE scope=?`).run(+enabled, +enabled, +enabled, now, now, scope);
    this.audit(enabled ? 'scope_enable' : 'scope_disable', scope, now);
    return this.policy(scope)!;
  }
  actor(scope: string, actor: string): ActorPolicy {
    return (this.db.prepare('SELECT * FROM actor_policies WHERE scope=? AND actor=?').get(scope, actor) as unknown as ActorPolicy | undefined)
      ?? { scope, actor, opted_out: 0, epoch: 0, enabled_ms: 0 };
  }
  setOptOut(scope: string, actor: string, out: boolean, now: number): void {
    this.db.prepare(`INSERT INTO actor_policies(scope,actor,opted_out,epoch,enabled_ms) VALUES (?,?,?,1,?)
      ON CONFLICT(scope,actor) DO UPDATE SET opted_out=excluded.opted_out,epoch=actor_policies.epoch+1,enabled_ms=excluded.enabled_ms`)
      .run(scope, actor, +out, now);
    this.audit(out ? 'actor_exit' : 'actor_resume', scope, now);
    if (out) this.wipeActor(scope, actor, now);
  }
  source(id: string): Source | undefined {
    return this.db.prepare('SELECT * FROM sources WHERE id=?').get(id) as unknown as Source | undefined;
  }
  addSource(scope: string, actor: string, messageKey: string, text: string, eventMs: number, now: number): Source | undefined {
    const policy = this.policy(scope); const ap = this.actor(scope, actor);
    if (!policy?.enabled || ap.opted_out || eventMs < Math.max(policy.enabled_ms, ap.enabled_ms)) return;
    if (this.db.prepare('SELECT 1 FROM message_tombstones WHERE scope=? AND message_key=?').get(scope, messageKey)) return;
    if (this.db.prepare('SELECT 1 FROM sources WHERE scope=? AND message_key=?').get(scope, messageKey)) return;
    const id = newId('ks');
    this.db.prepare(`INSERT INTO sources(id,scope,actor,message_key,text,event_ms,created_ms,epoch,actor_epoch)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, scope, actor, messageKey, text, eventMs, now, policy.epoch, ap.epoch);
    return this.source(id);
  }
  validSource(source: Source, now: number, config: KnowledgeConfig): boolean {
    const p = this.policy(source.scope); const a = this.actor(source.scope, source.actor);
    const current = this.source(source.id);
    return !!p?.enabled && !a.opted_out && source.epoch === p.epoch && source.actor_epoch === a.epoch
      && current?.version === source.version && current.state === 'live'
      && current.created_ms > now - config.rawRetentionDays * DAY;
  }
  answer(sourceId: string, text: string): void {
    this.db.prepare("UPDATE sources SET answer=? WHERE id=? AND state='live'").run(text, sourceId);
  }
  pendingCount(scope: string, now: number, config: KnowledgeConfig, actor?: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) n FROM sources s JOIN scope_policies p ON p.scope=s.scope
      LEFT JOIN actor_policies a ON a.scope=s.scope AND a.actor=s.actor
      WHERE s.scope=? AND s.state='live' AND s.processed=0 AND p.enabled=1 AND s.epoch=p.epoch
      AND s.actor_epoch=COALESCE(a.epoch,0) AND COALESCE(a.opted_out,0)=0 AND s.created_ms>?
      AND (? IS NULL OR s.actor=?)`)
      .get(scope, now - config.rawRetentionDays * DAY, actor ?? null, actor ?? null) as { n: number };
    return row.n;
  }
  recent(scope: string, actor: string, now: number, epoch: number): Source[] {
    return this.db.prepare(`SELECT * FROM sources WHERE scope=? AND actor=? AND state='live' AND epoch=?
      AND actor_epoch=? AND created_ms>? ORDER BY created_ms DESC,rowid DESC LIMIT 6`)
      .all(scope, actor, epoch, this.actor(scope, actor).epoch, now - DAY) as unknown as Source[];
  }
  getItem(id: string, scope: string, actor: string, candidates = false): Item | undefined {
    const item = this.db.prepare(`SELECT * FROM items WHERE id=? AND scope=?
      AND (actor=? OR audience='group') AND status IN (${candidates ? "'active','candidate'" : "'active'"})`)
      .get(id, scope, actor) as unknown as Item | undefined;
    return item && !sensitive(item.body) ? item : undefined;
  }
  search(scope: string, actor: string, query: string, limit = 8): Item[] {
    query = query.trim().slice(0, 200);
    if (!query) return [];
    const terms = queryTerms(query);
    const fts = terms.filter(t => [...t].length >= 3).map(t => `"${t.replaceAll('"', '""')}"`).join(' OR ');
    let rows: Item[] = [];
    if (fts) {
      rows = this.db.prepare(`SELECT i.* FROM items i JOIN item_fts f ON f.item_id=i.id
        WHERE item_fts MATCH ? AND i.scope=? AND (i.actor=? OR i.audience='group') AND i.status='active'
        ORDER BY (instr(i.body,?)>0) DESC,bm25(item_fts),i.updated_ms DESC LIMIT ?`)
        .all(fts, scope, actor, query, limit) as unknown as Item[];
    }
    // Short Chinese words and punctuation stay literal; permission filters apply inside SQL.
    if (rows.length < limit) {
      const predicates = terms.map(() => '(instr(body,?)>0 OR instr(title,?)>0)').join(' OR ');
      const fallback = this.db.prepare(`SELECT * FROM items WHERE scope=? AND (actor=? OR audience='group')
        AND status='active' AND (${predicates}) ORDER BY (instr(body,?)>0) DESC,updated_ms DESC LIMIT ?`)
        .all(scope, actor, ...terms.flatMap(t => [t, t]), query, limit) as unknown as Item[];
      const seen = new Set(rows.map(x => x.id));
      rows.push(...fallback.filter(x => !seen.has(x.id)));
    }
    return rows.filter(x => !sensitive(x.body)).slice(0, limit);
  }
  private syncIndex(item: Item): void {
    this.db.prepare('DELETE FROM item_fts WHERE item_id=?').run(item.id);
    if (item.status === 'active' && !sensitive(item.body)) this.db.prepare('INSERT INTO item_fts(item_id,body) VALUES (?,?)').run(item.id, `${item.title}\n${item.body}`);
  }
  private writeRevision(item: Item, sources: Source[], proposal: Proposal, now: number): void {
    this.db.prepare('INSERT INTO revisions(item_id,revision,title,body,conditions,verification,created_ms) VALUES (?,?,?,?,?,?,?)')
      .run(item.id, item.revision, item.title, item.body, item.conditions, item.verification, now);
    this.appendEvidence(item, sources, proposal);
    this.syncIndex(item);
  }
  private appendEvidence(item: Item, sources: Source[], proposal: Proposal): number {
    let added = 0;
    for (const e of proposal.evidence) {
      const source = sources.find(s => s.id === e.sourceId)!;
      added += Number(this.db.prepare('INSERT OR IGNORE INTO evidence(item_id,revision,source_id,source_version,quote) VALUES (?,?,?,?,?)')
        .run(item.id, item.revision, source.id, source.version, e.quote).changes);
    }
    return added;
  }
  apply(proposal: Proposal, sources: Source[], now: number, ownerId: string): Item | undefined {
    if (!sources.length || sensitive(`${proposal.title}\n${proposal.body}\n${proposal.conditions.join('\n')}`)) return;
    if (sources.some(s => s.scope !== sources[0].scope || s.actor !== sources[0].actor)) return;
    // Defense in depth: even direct store callers cannot apply a stale or revoked human snapshot.
    for (const source of sources) {
      const current = this.source(source.id), p = this.policy(source.scope), a = this.actor(source.scope, source.actor);
      if (!current || current.state !== 'live' || current.version !== source.version || current.text !== source.text
        || !p?.enabled || p.epoch !== source.epoch || a.opted_out || a.epoch !== source.actor_epoch) return;
    }
    if (!proposal.evidence.length || proposal.evidence.some(e => !sources.some(s => s.id === e.sourceId && s.text.includes(e.quote)))) return;
    const quality = classify(proposal, sources);
    const scope = sources[0].scope, actor = sources[0].actor;
    if (proposal.operation === 'revise') {
      const old = this.getItem(proposal.targetItemId!, scope, actor, true);
      if (!old || (old.actor !== actor && !(old.audience === 'group' && actor === ownerId))) return;
      // Self correction / public updates require a genuine explicit correction source, never model identity.
      if (!sources.some(s => intent(s.text, 'correct', old.id))) return;
      // A public item cannot be converted into personal content under its original publisher,
      // including by the owner. Unconfirmed/low-quality public replacements are rejected intact.
      if (old.audience === 'group' && (proposal.kind !== 'knowledge' || quality.audience !== 'group' || quality.status !== 'active')) return;
      // Revisions never widen an existing subject_only item to group visibility.
      const audience = old.audience === 'group' ? 'group' : 'subject_only';
      const update = this.db.prepare(`UPDATE items SET title=?,body=?,conditions=?,kind=?,audience=?,revision=revision+1,status=?,verification=?,updated_ms=?
        WHERE id=? AND revision=? AND status IN ('active','candidate')`)
        .run(proposal.title, proposal.body, JSON.stringify(proposal.conditions), proposal.kind, audience,
          quality.status, quality.verification, now, old.id, proposal.expectedRevision!);
      if (!update.changes) return;
      const item = this.db.prepare('SELECT * FROM items WHERE id=?').get(old.id) as unknown as Item;
      this.writeRevision(item, sources, proposal, now);
      this.audit('revise', scope, now, item.id);
      return item;
    }
    const identical = this.db.prepare(`SELECT * FROM items WHERE scope=? AND actor=? AND kind=? AND body=? AND conditions=?
      AND audience=? AND verification=? AND status=? LIMIT 1`)
      .get(scope, actor, proposal.kind, proposal.body, JSON.stringify(proposal.conditions), quality.audience, quality.verification, quality.status) as unknown as Item | undefined;
    if (identical) {
      if (this.appendEvidence(identical, sources, proposal)) {
        this.db.prepare('UPDATE items SET updated_ms=? WHERE id=?').run(now, identical.id);
        identical.updated_ms = now;
        this.audit('reinforce', scope, now, identical.id);
      }
      return identical;
    }
    // Tombstoned origins remain unique, so a retry cannot re-create a forgotten item.
    const origin = digest(`${scope}|${actor}|${proposal.kind}|${sources.map(s => s.id).sort().join(',')}|${proposal.body}`);
    if (this.db.prepare('SELECT 1 FROM items WHERE origin_key=?').get(origin)) return;
    const item: Item = {
      id: newId('ki'), scope, actor, audience: quality.audience, kind: proposal.kind,
      title: proposal.title, body: proposal.body, conditions: JSON.stringify(proposal.conditions),
      revision: 1, status: quality.status, verification: quality.verification,
      created_ms: now, updated_ms: now, origin_key: origin,
    };
    this.insertItem(item); this.writeRevision(item, sources, proposal, now);
    this.audit('create', scope, now, item.id); return item;
  }
  private insertItem(item: Item): void {
    this.db.prepare(`INSERT INTO items(id,scope,actor,audience,kind,title,body,conditions,revision,status,verification,created_ms,updated_ms,origin_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(item.id, item.scope, item.actor, item.audience, item.kind,
      item.title, item.body, item.conditions, item.revision, item.status, item.verification, item.created_ms, item.updated_ms, item.origin_key);
  }
  importLegacy(scope: string, actor: string, records: { id: string; text: string }[], now: number): void {
    if (this.db.prepare('SELECT 1 FROM legacy_imports WHERE scope=?').get(scope)) return;
    this.tx(() => {
      for (const record of records) {
        if (sensitive(record.text)) continue;
        const item: Item = { id: newId('ki'), scope, actor, audience: 'subject_only', kind: 'profile',
          title: '既有长期记忆（未经验证）', body: record.text, conditions: '[]', revision: 1,
          status: 'active', verification: 'legacy_unverified', created_ms: now, updated_ms: now,
          origin_key: `legacy:${scope}:${digest(record.id)}` };
        if (this.db.prepare('SELECT 1 FROM items WHERE origin_key=?').get(item.origin_key)) continue;
        this.insertItem(item);
        this.db.prepare('INSERT INTO revisions(item_id,revision,title,body,conditions,verification,created_ms) VALUES (?,?,?,?,?,?,?)')
          .run(item.id, 1, item.title, item.body, '[]', item.verification, now);
        this.syncIndex(item);
      }
      this.db.prepare('INSERT INTO legacy_imports(scope,completed_ms) VALUES (?,?)').run(scope, now);
      this.audit('legacy_import', scope, now);
    });
  }
  wipeItem(id: string, now = Date.now()): void {
    const metadata = this.db.prepare('SELECT scope FROM items WHERE id=?').get(id) as { scope: string } | undefined;
    const update = this.db.prepare("UPDATE items SET title='',body='',conditions='[]',status='deleted',verification='',revision=revision+1 WHERE id=? AND status!='deleted'").run(id);
    if (update.changes && metadata) this.audit('delete', metadata.scope, now, id);
    this.db.prepare('DELETE FROM revisions WHERE item_id=?').run(id);
    this.db.prepare('DELETE FROM evidence WHERE item_id=?').run(id);
    this.db.prepare('DELETE FROM item_fts WHERE item_id=?').run(id);
  }
  wipeSource(id: string, now = Date.now()): void {
    const linked = this.db.prepare('SELECT DISTINCT item_id FROM evidence WHERE source_id=?').all(id) as { item_id: string }[];
    for (const row of linked) this.wipeItem(row.item_id, now);
    const source = this.source(id);
    if (source) this.db.prepare('INSERT OR IGNORE INTO message_tombstones(scope,message_key) VALUES (?,?)').run(source.scope, source.message_key);
    this.db.prepare("UPDATE sources SET text='',answer='',state='deleted',version=version+1,processed=1 WHERE id=?").run(id);
  }
  forgetItem(id: string, now = Date.now()): void {
    const sources = this.db.prepare('SELECT DISTINCT source_id FROM evidence WHERE item_id=?').all(id) as { source_id: string }[];
    this.wipeItem(id, now);
    // Also invalidates the source snapshot of every outstanding worker, not just this item ID.
    for (const source of sources) this.wipeSource(source.source_id, now);
  }
  wipeActor(scope: string, actor: string, now = Date.now()): void {
    for (const source of this.db.prepare('SELECT id FROM sources WHERE scope=? AND actor=?').all(scope, actor) as { id: string }[]) this.wipeSource(source.id, now);
    for (const item of this.db.prepare('SELECT id FROM items WHERE scope=? AND actor=?').all(scope, actor) as { id: string }[]) this.wipeItem(item.id, now);
  }
  retract(scope: string, key: string, now = Date.now()): void {
    this.tx(() => {
      this.db.prepare('INSERT OR IGNORE INTO message_tombstones(scope,message_key) VALUES (?,?)').run(scope, key);
      const source = this.db.prepare('SELECT id FROM sources WHERE scope=? AND message_key=?').get(scope, key) as { id: string } | undefined;
      if (source) this.wipeSource(source.id, now);
      this.audit('retract', scope, now);
    });
  }
  private recoverLeases(now: number): void {
    const expired = this.db.prepare("SELECT * FROM jobs WHERE state='leased' AND lease_until<=?").all(now) as unknown as Lease[];
    for (const job of expired) {
      if (job.attempts >= 3) this.fail(job, now);
      else this.db.prepare("UPDATE jobs SET state='pending',lease_token='',lease_until=0 WHERE id=? AND lease_token=?").run(job.id, job.lease_token);
    }
  }
  maintain(now: number, config: KnowledgeConfig): void {
    this.tx(() => {
      for (const item of this.db.prepare("SELECT id FROM items WHERE status='candidate' AND created_ms<=?").all(now - config.candidateRetentionDays * DAY) as { id: string }[]) this.forgetItem(item.id, now);
      // Retention expires raw text, not active minimal evidence; revoked sources instead wipe all evidence.
      this.db.prepare("UPDATE sources SET text='',answer='',state='expired',version=version+1,processed=1 WHERE state='live' AND created_ms<=?").run(now - config.rawRetentionDays * DAY);
      this.db.prepare('DELETE FROM model_calls WHERE called_ms<?').run(now - 3600000);
      this.db.prepare('DELETE FROM audit_events WHERE created_ms<?').run(now - 90 * DAY);
      this.recoverLeases(now);
    });
    // Best effort logical/WAL cleanup, not a promise of physical media erasure.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  claim(now: number, config: KnowledgeConfig, allowed: (scope: string) => boolean): Lease | undefined {
    return this.tx(() => {
      this.recoverLeases(now);
      const pending = this.db.prepare("SELECT * FROM jobs WHERE state='pending' AND retry_ms<=? AND attempts<3 ORDER BY created_ms LIMIT 100").all(now) as unknown as Lease[];
      let job = pending.find(j => allowed(j.scope) && this.policy(j.scope)?.enabled && !this.actor(j.scope, j.actor).opted_out);
      if (!job) {
        const scopes = this.db.prepare(`SELECT DISTINCT scope,actor FROM sources WHERE processed=0 AND state='live'
          AND created_ms>? ORDER BY created_ms LIMIT 100`).all(now - config.rawRetentionDays * DAY) as { scope: string; actor: string }[];
        for (const pair of scopes) {
          if (!allowed(pair.scope)) continue;
          const p = this.policy(pair.scope), a = this.actor(pair.scope, pair.actor);
          if (!p?.enabled || a.opted_out) continue;
          if (this.db.prepare("SELECT 1 FROM jobs WHERE scope=? AND actor=? AND state IN ('pending','leased')").get(pair.scope, pair.actor)) continue;
          const rows = this.db.prepare(`SELECT * FROM sources WHERE scope=? AND actor=? AND epoch=? AND actor_epoch=?
            AND processed=0 AND state='live' AND created_ms>? ORDER BY created_ms,rowid LIMIT ?`)
            .all(pair.scope, pair.actor, p.epoch, a.epoch, now - config.rawRetentionDays * DAY, config.batchMaxMessages) as unknown as Source[];
          const batch: Source[] = []; let chars = 0;
          for (const s of rows) {
            const size = s.text.length + s.answer.length;
            if (chars + size > config.batchMaxChars) break;
            batch.push(s); chars += size;
          }
          if (!batch.length) continue;
          const id = newId('kj');
          const snapshots = JSON.stringify(batch.map(s => ({ id: s.id, version: s.version })));
          const referenced = [...new Set(batch.flatMap(s => s.text.match(/ki_[a-f0-9]{32}/g) ?? []))].slice(0, 32);
          const itemVersions: Record<string, number> = {};
          for (const itemId of referenced) {
            const item = this.getItem(itemId, pair.scope, pair.actor, true);
            if (item) itemVersions[itemId] = item.revision;
          }
          this.db.prepare('INSERT INTO jobs(id,scope,actor,epoch,actor_epoch,sources,item_versions,created_ms) VALUES (?,?,?,?,?,?,?,?)')
            .run(id, pair.scope, pair.actor, p.epoch, a.epoch, snapshots, JSON.stringify(itemVersions), now);
          job = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as unknown as Lease;
          break;
        }
      }
      if (!job) return;
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM model_calls WHERE scope=? AND called_ms>?').get(job.scope, now - 3600000) as { n: number };
      if (count.n >= config.maxCallsPerScopePerHour) return;
      const token = newId('lease');
      this.db.prepare("UPDATE jobs SET state='leased',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(token, now + 90000, job.id);
      this.db.prepare('INSERT INTO model_calls(scope,called_ms) VALUES (?,?)').run(job.scope, now);
      return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id) as unknown as Lease;
    });
  }
  leaseSources(job: Lease): Source[] {
    const snapshots = JSON.parse(job.sources) as { id: string; version: number }[];
    const sources = snapshots.map(s => this.source(s.id));
    if (sources.some((s, i) => !s || s.version !== snapshots[i].version)) return [];
    return sources as Source[];
  }
  leaseValid(job: Lease, now: number, config: KnowledgeConfig): boolean {
    const current = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id) as unknown as Lease | undefined;
    const p = this.policy(job.scope), a = this.actor(job.scope, job.actor);
    const sources = this.leaseSources(job);
    return current?.state === 'leased' && current.lease_token === job.lease_token && current.lease_until > now
      && p?.epoch === job.epoch && !!p.enabled && a.epoch === job.actor_epoch && !a.opted_out
      && sources.length > 0 && sources.every(s => this.validSource(s, now, config));
  }
  complete(job: Lease): void {
    for (const s of this.leaseSources(job)) this.db.prepare('UPDATE sources SET processed=1 WHERE id=? AND version=?').run(s.id, s.version);
    this.db.prepare("UPDATE jobs SET state='done',lease_token='',lease_until=0 WHERE id=? AND lease_token=?").run(job.id, job.lease_token);
  }
  fail(job: Lease, now: number, cancelled = false): void {
    const update = this.db.prepare(`UPDATE jobs SET state=?,retry_ms=?,lease_token='',lease_until=0 WHERE id=? AND state='leased' AND lease_token=?`)
      .run(cancelled ? 'cancelled' : job.attempts >= 3 ? 'failed' : 'pending', now + Math.min(300000, 1000 * 2 ** job.attempts), job.id, job.lease_token);
    if (update.changes && (cancelled || job.attempts >= 3)) {
      for (const s of JSON.parse(job.sources) as { id: string; version: number }[]) this.db.prepare('UPDATE sources SET processed=-1 WHERE id=? AND version=? AND processed=0').run(s.id, s.version);
    }
  }
  close(): void { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close(); }
}
