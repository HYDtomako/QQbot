export interface KnowledgeOptions {
  enabled?: boolean;
  groups?: string[];
  privateUsers?: string[];
  automatic?: boolean;
  extractIntervalMs?: number;
  batchMaxMessages?: number;
  batchMaxChars?: number;
  maxCallsPerScopePerHour?: number;
  rawRetentionDays?: number;
  candidateRetentionDays?: number;
  retrievalMaxChars?: number;
}
export type KnowledgeConfig = Required<KnowledgeOptions>;
export interface KnowledgeInput {
  kind: 'group' | 'private';
  userId: string;
  groupId?: string;
  text: string;
  messageId?: string;
  eventTimeMs?: number;
  receivedAtMs?: number;
  senderRole?: string;
  normal: boolean;
  addressed: boolean;
}
export interface KnowledgeTurn {
  env: Record<string, string>;
  contextBlock: string;
  sourceId?: string;
  runId?: string;
}
export interface Source {
  id: string; scope: string; actor: string; message_key: string;
  text: string; answer: string; event_ms: number; created_ms: number;
  epoch: number; actor_epoch: number; version: number; state: string;
  processed: number;
}
export interface Item {
  id: string; scope: string; actor: string; audience: 'subject_only' | 'group';
  kind: string; title: string; body: string; conditions: string;
  revision: number; status: string; verification: string;
  created_ms: number; updated_ms: number; origin_key: string;
}
export interface Evidence { sourceId: string; quote: string }
export interface Proposal {
  operation: 'create' | 'revise';
  targetItemId?: string;
  expectedRevision?: number;
  kind: 'profile' | 'preference' | 'task' | 'decision' | 'knowledge';
  title: string;
  body: string;
  conditions: string[];
  evidence: Evidence[];
}
export interface ScopePolicy {
  scope: string; enabled: number; ever_enabled: number;
  first_enabled_ms: number; enabled_ms: number; epoch: number;
}
export interface ActorPolicy {
  scope: string; actor: string; opted_out: number; epoch: number; enabled_ms: number;
}
export interface Lease {
  id: string; scope: string; actor: string; epoch: number; actor_epoch: number;
  sources: string; item_versions: string; state: string; lease_until: number; attempts: number;
  lease_token: string; retry_ms: number;
}
export interface ModelResult { ok: boolean; text: string; durationMs?: number }
export type KnowledgeRunModel = (prompt: string, signal?: AbortSignal) => Promise<ModelResult>;
