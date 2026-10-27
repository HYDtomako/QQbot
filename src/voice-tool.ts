/**
 * voice_send 工具（模型主动要求"用语音说"）的桥接侧实现。
 *
 * 与 tts.ts 的概率钩子分开：钩子是把已经写好的文字回复随机改发语音；
 * 这里是被模型显式调用、把指定文本合成语音发到当前群，成功之后本轮不再补发文字。
 *
 * 约定：所有失败都收敛成 ok:false + 简短原因，绝不向上抛异常；
 * 日志只记字数、音色和耗时，不记文本全文与密钥。
 */

import { synthesizeMp3, TTS_DEFAULTS, type TtsConfig, type TtsFetch } from "./tts.ts";

/** 工具专用上限：比自动钩子的 maxChars 宽，但仍然只适合短句。 */
export const VOICE_TOOL_MAX_CHARS = 200;

export interface VoicePreset {
  /** 中文音色名，模型可以直接写这个。 */
  name: string;
  /** MiniMax voice_id。 */
  id: string;
}

/** 内置音色白名单：中文名与 voice_id 双向可查，模型编的无效值不会直接打到接口。 */
export const VOICE_PRESETS: readonly VoicePreset[] = [
  { name: "少女", id: "female-shaonv" },
  { name: "御姐", id: "female-yujie" },
  { name: "成熟女性", id: "female-chengshu" },
  { name: "甜美", id: "female-tianmei" },
  { name: "青涩青年", id: "male-qn-qingse" },
  { name: "精英青年", id: "male-qn-jingying" },
  { name: "霸道青年", id: "male-qn-badao" },
  { name: "青年大学生", id: "male-qn-daxuesheng" },
  { name: "萌女童", id: "lovely_girl" },
  { name: "男童", id: "cute_boy" },
];

export interface VoiceChoice {
  voiceId: string;
  /** 展示用名称；未命中白名单时是回退后的 voice_id。 */
  name: string;
  /** 是否命中白名单（未命中 = 静默回退到配置的默认音色）。 */
  matched: boolean;
}

function presetOf(voiceId: string): VoicePreset | undefined {
  return VOICE_PRESETS.find((p) => p.id === voiceId.toLowerCase());
}

/**
 * 把模型给的中文名或 voice_id 解析成合法 voice_id。
 * 空值、未命中、非字符串一律回退到 tts.voiceId（再退到内置默认）。
 */
export function resolveVoiceId(value: unknown, fallback?: string): VoiceChoice {
  const fallbackId = presetOf(String(fallback ?? "").trim())?.id
    ?? (String(fallback ?? "").trim() || TTS_DEFAULTS.voiceId);
  const fallbackName = presetOf(fallbackId)?.name ?? fallbackId;
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { voiceId: fallbackId, name: fallbackName, matched: false };
  const hit = VOICE_PRESETS.find((p) => p.name === raw || p.id === raw.toLowerCase());
  if (hit) return { voiceId: hit.id, name: hit.name, matched: true };
  return { voiceId: fallbackId, name: fallbackName, matched: false };
}

/**
 * 朗读前的清洗：去掉代码块、Markdown 标记与链接，多行压成一行。
 * 模型已经按要求清洗过时这里基本不改动内容。
 */
export function sanitizeSpeakText(raw: unknown): string {
  let t = typeof raw === "string" ? raw : "";
  t = t
    .replace(/```[\s\S]*?```/g, " ") // 代码块整段不读
    .replace(/`([^`\n]*)`/g, "$1") // 行内代码保留内容
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // 图片
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // 链接保留文字
    .replace(/(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/^[ \t]*[-+][ \t]+/gm, "") // 列表符号
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/[*_~>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t;
}

export interface VoiceToolInput {
  /** 当前会话的 tts 配置（含 allowOthers）。 */
  cfg?: TtsConfig | null;
  /** 当前回合是否娱乐模式群（桥接按会话判定，不信模型自述）。 */
  isEntertainmentGroup: boolean;
  /** 发起本轮消息的 QQ 号（来自桥接绑定，不是工具参数）。 */
  asker: string;
  owner: string;
  whitelist?: readonly string[];
  text: unknown;
  voice: unknown;
}

export interface VoiceToolDeps {
  /** 真正发出语音；返回 false 表示明确失败。允许抛异常，内部会兜住。 */
  sendRecord(groupId: string, audio: Buffer): Promise<boolean>;
  fetchImpl?: TtsFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  log?: (message: string) => void;
}

export interface VoiceToolResult {
  ok: boolean;
  /** 给模型看的一句话（成功信息或简短原因），可直接引用。 */
  text: string;
  voiceId?: string;
  voiceName?: string;
  chars?: number;
  elapsedMs?: number;
  reason?: string;
}

function deny(reason: string, text: string): VoiceToolResult {
  return { ok: false, text, reason };
}

/**
 * 桥接侧的完整流程：权限与模式判定 → 清洗/限长 → 合成 → 发到当前群。
 * 任何一步失败都返回 ok:false，由模型改用文字回复。
 */
export async function runVoiceSend(opts: {
  groupId: string;
  input: VoiceToolInput;
  deps: VoiceToolDeps;
}): Promise<VoiceToolResult> {
  try {
    const { input, deps } = opts;
    const cfg = input.cfg ?? undefined;

    if (!input.isEntertainmentGroup) {
      return deny("非娱乐群", "语音没有发出：只有娱乐模式群可以发语音，这里请直接用文字回复。");
    }
    if (cfg?.enabled !== true) {
      return deny("语音未开启", "语音没有发出：语音功能当前未开启，请直接用文字回复。");
    }
    const asker = String(input.asker ?? "").trim();
    const whitelist = (input.whitelist ?? []).map(String);
    const permitted = !!asker && (asker === String(input.owner ?? "") || whitelist.includes(asker));
    if (!permitted && cfg?.allowOthers !== true) {
      return deny("无权限", "语音没有发出：仅院长可指定语音。");
    }
    if (!cfg.apiKey || !cfg.baseUrl) {
      return deny("配置不完整", "语音没有发出：语音配置不完整，请直接用文字回复。");
    }
    if (!opts.groupId) {
      return deny("无目标群", "语音没有发出：当前会话没有群号，请直接用文字回复。");
    }

    const speak = sanitizeSpeakText(input.text);
    if (!speak) {
      return deny("空文本", "语音没有发出：没有可朗读的文字（代码、链接和符号不算），请直接用文字回复。");
    }
    if (speak.length > VOICE_TOOL_MAX_CHARS) {
      return deny("超长", `语音没有发出：要朗读的文字太长（${speak.length} 字），请压缩到 ${VOICE_TOOL_MAX_CHARS} 字以内再调用。`);
    }
    if (deps.signal?.aborted) {
      return deny("已取消", "语音没有发出：本轮已取消，请直接用文字回复。");
    }

    const choice = resolveVoiceId(input.voice, cfg.voiceId);
    const started = Date.now();
    const audio = await synthesizeMp3({ ...cfg, voiceId: choice.voiceId }, speak, {
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs,
      signal: deps.signal,
    });
    if (!audio) {
      deps.log?.(`[voice] 合成失败（${speak.length} 字，音色 ${choice.voiceId}）`);
      return deny("合成失败", "语音没有发出：语音合成失败，请直接用文字回复。");
    }
    if (deps.signal?.aborted) {
      deps.log?.(`[voice] 已取消（${speak.length} 字，音色 ${choice.voiceId}）`);
      return deny("已取消", "语音没有发出：本轮已取消，请直接用文字回复。");
    }
    let sent = false;
    try {
      sent = await deps.sendRecord(opts.groupId, audio);
    } catch {
      sent = false;
    }
    const elapsedMs = Date.now() - started;
    if (!sent) {
      deps.log?.(`[voice] 发送失败（${speak.length} 字，音色 ${choice.voiceId}，${elapsedMs}ms）`);
      return deny("发送失败", "语音没有发出：语音发送失败，请直接用文字回复。");
    }
    deps.log?.(`[voice] 已发送语音（${speak.length} 字，音色 ${choice.voiceId}，${elapsedMs}ms）`);
    return {
      ok: true,
      text:
        `语音已发出（音色：${choice.name}（${choice.voiceId}）；${speak.length} 字；耗时 ${elapsedMs}ms）。` +
        `语音就是本轮回复：不要再发任何文字或表情包，别再回「好」之类的确认，也不要重复朗读内容。`,
      voiceId: choice.voiceId,
      voiceName: choice.name,
      chars: speak.length,
      elapsedMs,
    };
  } catch {
    return deny("异常", "语音没有发出：语音流程异常，请直接用文字回复。");
  }
}
