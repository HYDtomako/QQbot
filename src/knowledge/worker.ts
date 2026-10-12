import type { KnowledgeConfig, KnowledgeRunModel, ModelResult } from './types.ts';
import { KnowledgeStore } from './store.ts';
import { extractionPrompt, validateProposals } from './extractor.ts';

export interface WorkerOptions {
  store: KnowledgeStore; config: KnowledgeConfig; ownerId: string;
  allowed: (scope: string) => boolean; isNormal: (scope: string) => boolean;
  runModel: KnowledgeRunModel;
  now: () => number; log?: (...args: any[]) => void;
  // Local worker testing/tuning only; the service retains 60s / 30s defaults.
  modelTimeoutMs?: number;
  soonDelayMs?: number;
}
export class KnowledgeWorker {
  private options: WorkerOptions;
  private timer?: ReturnType<typeof setInterval>;
  private soonTimer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private controller?: AbortController;
  private stopping = false;
  constructor(options: WorkerOptions) { this.options = options; }
  start(): void {
    if (this.timer) return;
    this.stopping = false;
    // No immediate run: foreground startup and explicit authorization take priority.
    this.timer = setInterval(() => { void this.tick().catch(() => this.options.log?.('knowledge', 'maintenance_failed')); }, this.options.config.extractIntervalMs);
    this.timer.unref();
  }
  scheduleSoon(): void {
    if (this.stopping || this.soonTimer || !this.options.config.enabled || !this.options.config.automatic) return;
    // Coalesce from the first signal; do not reset indefinitely under continuous traffic.
    // Every scheduled tick still honors authorization, entertainment pause and the persistent budget.
    this.soonTimer = setTimeout(() => {
      this.soonTimer = undefined;
      void this.tick().catch(() => this.options.log?.('knowledge', 'maintenance_failed'));
    }, this.options.soonDelayMs ?? 30000);
    this.soonTimer.unref();
  }
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.runOnce().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async runOnce(): Promise<void> {
    const o = this.options;
    o.store.maintain(o.now(), o.config);
    if (!o.config.enabled || !o.config.automatic || this.stopping) return;
    const job = o.store.claim(o.now(), o.config, scope => o.allowed(scope) && o.isNormal(scope));
    if (!job) return;
    if (!o.store.leaseValid(job, o.now(), o.config)) { o.store.fail(job, o.now(), true); return; }
    const sources = o.store.leaseSources(job);
    const itemVersions = JSON.parse(job.item_versions) as Record<string, number>;
    const controller = new AbortController();
    this.controller = controller;
    let rejectAbort: ((reason?: unknown) => void) | undefined;
    const aborted = new Promise<ModelResult>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort?.(controller.signal.reason ?? new Error('model_aborted'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('model_timeout')), o.modelTimeoutMs ?? 60000);
    try {
      // The caller supplies the maintenance-priority, --no-tools, no-session runner.
      // signal cancels a queued runner task as well as a running task; old one-argument mocks remain valid.
      const result = await Promise.race([
        o.runModel(extractionPrompt(sources, itemVersions), controller.signal), aborted,
      ]);
      if (!result.ok) throw new Error('model_failed');
      const proposals = validateProposals(result.text, sources);
      if (proposals.some(p => p.operation === 'revise' && itemVersions[p.targetItemId!] !== p.expectedRevision)) throw new Error('proposal_snapshot_cas');
      if (this.stopping || controller.signal.aborted) { o.store.fail(job, o.now()); return; }
      if (!o.allowed(job.scope) || !o.store.leaseValid(job, o.now(), o.config)) {
        o.store.fail(job, o.now(), true); return;
      }
      if (!o.isNormal(job.scope)) { o.store.fail(job, o.now()); return; }
      o.store.tx(() => {
        // Transactional commit rechecks policy, epoch, source versions, deletion and lease ownership.
        if (this.stopping || controller.signal.aborted || !o.allowed(job.scope) || !o.isNormal(job.scope)
          || !o.store.leaseValid(job, o.now(), o.config)) {
          o.store.fail(job, o.now(), true); return;
        }
        let accepted = 0;
        for (const p of proposals) {
          const evidenceSources = sources.filter(s => p.evidence.some(e => e.sourceId === s.id));
          if (o.store.apply(p, evidenceSources, o.now(), o.ownerId)) accepted++;
        }
        o.store.complete(job);
        o.log?.('knowledge', 'batch_done', { proposals: proposals.length, accepted });
      });
    } catch {
      // Never log prompts, model output, raw messages, evidence, or exception messages.
      o.store.fail(job, o.now(), !o.allowed(job.scope) || !o.store.leaseValid(job, o.now(), o.config));
      o.log?.('knowledge', 'batch_failed', { attempts: job.attempts, aborted: controller.signal.aborted });
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
      if (this.controller === controller) this.controller = undefined;
    }
  }
  async close(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.timer = undefined; this.soonTimer = undefined;
    this.controller?.abort(new Error('worker_closed'));
    await this.running;
  }
}
