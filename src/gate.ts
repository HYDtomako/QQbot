/**
 * 主动插话门控：移植自麦麦（MaiBot, github.com/Mai-with-u/MaiBot）
 * 的 src/maisaka/turn_trigger/。
 *
 * 两块：
 *   - estimateReplyProbability：已拟合好的逻辑回归（截距 + 8 个权重），
 *     代入当前对话快照算出“值得插话”的概率。
 *   - DynamicReplyGate：按院长设定的目标回复频率动态调阈值，让实际插话
 *     密度贴近预期。
 *
 * 只对 modes.json 里开了娱乐模式的群生效。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 以下两块从麦麦（MaiBot, github.com/Mai-with-u/MaiBot）的
// src/maisaka/turn_trigger/ 移植而来，用于“主动插话”的概率门控。
// 权重是人家在自家 QQ 群数据上拟合好的，先直接拿来当先验用。
// ─────────────────────────────────────────────────────────────────────────────

const MAX_PENDING_COUNT = 20;
const DEFAULT_SECONDS_SINCE_BOT_MESSAGE = 3600.0;

// 拟合权重：logit = 截距 + Σ 权重 × 特征（取自麦麦 reply_likelihood.py）
const LIKELIHOOD_INTERCEPT = -1.2005;
const W_MENTION_BOT = 1.5852;
const W_AT_OTHER = -1.1157;
const W_QUESTION_MARK = 0.4807;
const W_PLACEHOLDER_ONLY = -1.0281;
const W_RECENT_SELF_RATIO = 2.6525;
const W_RECENT_MESSAGE_COUNT = -0.0367;
const W_LOG_SECONDS_SINCE_BOT = 0.0571;
const W_PENDING_COUNT = 0.1012;

/** 估计一批新消息“值得插话”的概率（0~1）所需的对话快照。 */
export interface ReplyLikelihoodInput {
  mentionBot: boolean;
  atOther: boolean;
  hasQuestionMark: boolean;
  placeholderOnly: boolean;
  /** 最近 5 分钟里机器人发言所占比例 */
  recentSelfRatio: number;
  /** 最近 5 分钟的消息条数 */
  recentMessageCount: number;
  /** 距机器人上一次发言的秒数 */
  secondsSinceBotMessage: number;
  /** 本批待处理的外部消息条数 */
  pendingCount: number;
}

/** 逻辑回归打分：代入已拟合权重，sigmoid 得到概率。 */
export function estimateReplyProbability(input: ReplyLikelihoodInput): number {
  const logit =
    LIKELIHOOD_INTERCEPT +
    W_MENTION_BOT * Number(input.mentionBot) +
    W_AT_OTHER * Number(input.atOther) +
    W_QUESTION_MARK * Number(input.hasQuestionMark) +
    W_PLACEHOLDER_ONLY * Number(input.placeholderOnly) +
    W_RECENT_SELF_RATIO * Math.min(1, Math.max(0, input.recentSelfRatio)) +
    W_RECENT_MESSAGE_COUNT * Math.max(0, input.recentMessageCount) +
    W_LOG_SECONDS_SINCE_BOT * Math.log1p(Math.max(0, input.secondsSinceBotMessage)) +
    W_PENDING_COUNT * Math.min(MAX_PENDING_COUNT, Math.max(0, input.pendingCount));
  return 1 / (1 + Math.exp(-logit));
}

// 离线统计：保留多少比例的主动回复时对应的概率阈值，窗口样本不足时使用
const STATIC_KEEP_RATIO_THRESHOLDS: Array<[number, number]> = [
  [0.0, 1.0],
  [0.1, 0.605],
  [0.2, 0.482],
  [0.3, 0.43],
  [0.4, 0.376],
  [0.5, 0.336],
  [0.6, 0.313],
  [0.7, 0.29],
  [0.8, 0.25],
  [0.9, 0.206],
  [1.0, 0.0],
];
const REPLY_WINDOW_SECONDS = 3600;
const MIN_WINDOW_SCORE_COUNT = 20;
const VIRTUAL_ROUND_SECONDS = 40;
const FORCED_TURN_EXPECTED_REPLIES = 0.91;

export interface DynamicGateDecision {
  shouldTrigger: boolean;
  probability: number;
  threshold: number;
  expectedReplies: number;
  targetReplies: number;
  actualReplies: number;
  keepRatio: number;
}

function staticThreshold(keepRatio: number): number {
  for (let i = 0; i < STATIC_KEEP_RATIO_THRESHOLDS.length - 1; i++) {
    const [loR, loT] = STATIC_KEEP_RATIO_THRESHOLDS[i];
    const [hiR, hiT] = STATIC_KEEP_RATIO_THRESHOLDS[i + 1];
    if (keepRatio <= hiR) {
      const p = (keepRatio - loR) / (hiR - loR);
      return loT + (hiT - loT) * p;
    }
  }
  return 0.0;
}

/**
 * 单个群的动态回复门控状态（移植自麦麦 dynamic_gate.py）。
 * 目标：让窗口内实际插话次数贴近“不设门控时预计的次数 × 回复频率”。
 * 阈值按概率从高到低累计到“保留额度”处得到；只收紧不放宽，避免回复系统性偏多。
 */
export class DynamicReplyGate {
  private windowSeconds: number;
  private proactiveScores: Array<[number, number]> = []; // [ts, probability]
  private forcedExpectations: Array<[number, number]> = [];
  private replyTimes: number[] = [];
  private openRoundStartedAt: number | null = null;

  constructor(windowSeconds: number = REPLY_WINDOW_SECONDS) {
    this.windowSeconds = windowSeconds;
  }

  /** 当前是否仍处在一个尚未结束的虚拟轮次内。 */
  isRoundOpen(now: number): boolean {
    return this.openRoundStartedAt !== null && now - this.openRoundStartedAt < VIRTUAL_ROUND_SECONDS;
  }

  /** 记录本虚拟轮次预计带来的回复次数（同一轮次只计一次，覆盖式更新）。 */
  recordProactiveDemand(probability: number, now: number): void {
    if (this.isRoundOpen(now) && this.proactiveScores.length) {
      this.proactiveScores[this.proactiveScores.length - 1] = [this.openRoundStartedAt as number, probability];
      return;
    }
    this.openRoundStartedAt = now;
    this.proactiveScores.push([now, probability]);
  }

  closeRound(): void {
    this.openRoundStartedAt = null;
  }

  /** 被 @ 强制触发一次（预计回复数按实测均值计），同时结束当前轮次。 */
  recordForcedTurn(now: number): void {
    this.closeRound();
    this.forcedExpectations.push([now, FORCED_TURN_EXPECTED_REPLIES]);
  }

  recordReply(now: number): void {
    this.replyTimes.push(now);
  }

  private prune(now: number): void {
    const before = now - this.windowSeconds * 1000;
    this.proactiveScores = this.proactiveScores.filter((x) => x[0] >= before);
    this.forcedExpectations = this.forcedExpectations.filter((x) => x[0] >= before);
    this.replyTimes = this.replyTimes.filter((t) => t >= before);
  }

  /** 判断当前这批待处理消息是否放行。frequency 为目标回复频率（0~1）。 */
  evaluate(probability: number, frequency: number, now: number): DynamicGateDecision {
    this.prune(now);
    const proactiveScores = this.proactiveScores.map((x) => x[1]);
    const expectedProactive = proactiveScores.reduce((a, b) => a + b, 0);
    // 点名必回（forced）不计入主动插话预算：否则群里一次 @ 就会把额度吃光，
    // 之后一小时内再也不会主动插话。只按“主动需求”估预算。
    const expectedTotal = expectedProactive;
    const actualReplies = this.replyTimes.length;
    const freq = Math.min(1, Math.max(0, frequency));
    const targetReplies = freq * expectedTotal;

    let keepRatio: number;
    if (freq >= 1) keepRatio = 1;
    else if (expectedProactive <= 0) keepRatio = freq;
    else {
      const feedforward = targetReplies / expectedProactive;
      const feedback = Math.min(1, Math.max(0, 1 + (targetReplies - actualReplies) / Math.max(1, targetReplies)));
      keepRatio = Math.min(1, Math.max(0, feedforward * feedback));
    }

    const threshold = this.resolveThreshold(proactiveScores, expectedProactive, keepRatio);
    return {
      shouldTrigger: probability >= threshold,
      probability,
      threshold,
      expectedReplies: expectedTotal,
      targetReplies,
      actualReplies,
      keepRatio,
    };
  }

  private resolveThreshold(proactiveScores: number[], expectedProactive: number, keepRatio: number): number {
    if (keepRatio >= 1) return 0;
    if (keepRatio <= 0) return 1;
    if (proactiveScores.length < MIN_WINDOW_SCORE_COUNT) return staticThreshold(keepRatio);
    const budget = keepRatio * expectedProactive;
    let acc = 0;
    for (const score of [...proactiveScores].sort((a, b) => b - a)) {
      acc += score;
      if (acc >= budget) return score;
    }
    return 0;
  }
}
