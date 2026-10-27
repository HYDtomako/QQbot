/**
 * 娱乐模式语音回复：文本 → TTS → mp3 Buffer。
 *
 * 支持两个 provider：
 * - minimax（缺省）：POST `{baseUrl}/v1/t2a_v2`，返回 hex 音频。
 * - fish：POST `{baseUrl}/v1/tts`，返回音频二进制，可经 socks5 代理出网。
 *   模型名走 HTTP 头 `model`，body 只有 {text, reference_id, format}；
 *   把 model 放进 body 会被忽略（上游回 402），费用控制靠这个头生效。
 *
 * 约定：这里的所有失败都收敛成 null / false，绝不向上抛异常；
 * 调用方只在成功时把回复改成语音，其余情况照原样发文字。
 * 日志只允许出现字数、模型、耗时和错误类型，不记录文本全文与密钥。
 */

import { httpPostJson, type HttpPost } from "./socks-http.ts";

export interface TtsConfig {
  /** 合成服务商，缺省按 minimax 处理（老配置行为不变）。 */
  provider?: "minimax" | "fish";
  /** fish 走的本机代理，形如 socks5://127.0.0.1:10808；空串表示直连。 */
  proxy?: string;
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voiceId?: string;
  speed?: number;
  vol?: number;
  pitch?: number;
  probability?: number;
  maxChars?: number;
  format?: string;
  /** 是否允许院长/白名单以外的人调用 voice_send（voice-tool 读取，不影响概率钩子）。 */
  allowOthers?: boolean;
}

export const TTS_DEFAULTS = {
  provider: "minimax",
  proxy: "",
  model: "speech-2.8-turbo",
  voiceId: "female-shaonv",
  speed: 1,
  vol: 1,
  pitch: 0,
  probability: 0.35,
  maxChars: 80,
  format: "mp3",
  timeoutMs: 30000,
} as const;

/** 只依赖 fetch 的最小子集，方便自测注入 mock。 */
export interface TtsHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface TtsFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export type TtsFetch = (url: string, init: TtsFetchInit) => Promise<TtsHttpResponse>;

interface TtsResponseBody {
  data?: { audio?: unknown };
  base_resp?: { status_code?: unknown };
}

export interface VoicePlan {
  speak: boolean;
  /** 不转语音时的原因（简短标签，不含文本内容）。 */
  reason?: string;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return TTS_DEFAULTS.probability;
  return Math.min(1, Math.max(0, n));
}

/**
 * 可朗读性判定：通过返回 null，否则返回拒绝原因。
 * 目标是短、单段、口语文本；代码、链接、@、媒体标记和面板/统计符号都不朗读。
 */
export function voiceTextRejection(text: string, maxChars: number = TTS_DEFAULTS.maxChars): string | null {
  const t = String(text ?? "").trim();
  if (!t) return "空文本";
  const limit = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : TTS_DEFAULTS.maxChars;
  if (t.length > limit) return "超长";
  if (/[\r\n]/.test(t)) return "多行";
  if (/```|`/.test(t)) return "代码";
  if (/(?:https?:\/\/|www\.)\S+/i.test(t)) return "链接";
  if (/@\S/.test(t) || /\[CQ:at[,\]]/i.test(t)) return "@提及";
  if (/\[\[IMG:|\[图片\d*[：:，,\]]|\[表情包/.test(t)) return "媒体标记";
  // 框线/表格/统计面板类符号：读出来只会是噪音
  if (/[│┃┆┊╎╏┌┐└┘├┤┬┴┼─━═╔╗╚╝║▁▂▃▄▅▆▇█▓▒░•●○◆◇■□▪▫]/.test(t)) return "面板符号";
  if (/\|/.test(t) && t.split("|").length >= 3) return "表格";
  const sentences = (t.match(/[。！？!?；;…]+/g) ?? []).length;
  if (sentences > 2) return "句子过多";
  // 字母/数字/汉字和常用标点之外的字符占比过高，视为符号堆
  const symbols = (t.match(
    /[^\p{L}\p{N}\s，。！？、；：,.!?;:…—~～·"'“”‘’（）()《》【】]/gu,
  ) ?? []).length;
  if (symbols / t.length > 0.2) return "符号过多";
  return null;
}

/** 发送前决定形态：是否把这条纯文字回复改成语音。 */
export function planVoice(opts: {
  cfg?: TtsConfig | null;
  isEntertainmentGroup: boolean;
  text: string;
  random?: () => number;
}): VoicePlan {
  const cfg = opts.cfg;
  if (!cfg || cfg.enabled !== true) return { speak: false, reason: "关闭" };
  if (!opts.isEntertainmentGroup) return { speak: false, reason: "非娱乐群" };
  if (!cfg.apiKey || !cfg.baseUrl) return { speak: false, reason: "配置不完整" };
  const rejected = voiceTextRejection(opts.text, cfg.maxChars ?? TTS_DEFAULTS.maxChars);
  if (rejected) return { speak: false, reason: rejected };
  const probability = clamp01(cfg.probability ?? TTS_DEFAULTS.probability);
  if (probability <= 0) return { speak: false, reason: "概率为0" };
  const roll = (opts.random ?? Math.random)();
  if (!(roll < probability)) return { speak: false, reason: "未命中概率" };
  return { speak: true };
}

export interface SynthesizeOptions {
  fetchImpl?: TtsFetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** fish 专用：可注入的 HTTP 传输层（自测用；缺省走 socks-http 的真实实现）。 */
  httpPost?: HttpPost;
  /** 失败/超时的简短日志出口，只允许字数、模型、耗时、错误类型。 */
  log?: (message: string) => void;
}

/** 文本长度只用于日志，绝不记录内容本身。 */
function textLength(text: string): number {
  return String(text ?? "").trim().length;
}

/** 判断响应体是不是 JSON 错误体（音频二进制不会以 { 或 [ 开头）。 */
function looksLikeJsonBody(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x7b || byte === 0x5b;
  }
  return false;
}

/** 从异常里只取类型信息：Node 的 code（如 ETIMEDOUT），否则记"网络异常"。 */
function errorKind(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,32}$/.test(code)) return code;
  const message = err instanceof Error ? err.message : "";
  if (/超时|timeout/i.test(message)) return "超时";
  if (/取消/i.test(message)) return "已取消";
  return "网络异常";
}

/**
 * fish.audio：POST `{baseUrl}/v1/tts`，2xx 且响应体是音频二进制才算成功。
 * 非 2xx、空 body、JSON 错误体、网络异常、超时、取消一律返回 null。
 */
async function synthesizeFish(cfg: TtsConfig, text: string, opts: SynthesizeOptions): Promise<Buffer | null> {
  const apiKey = cfg.apiKey;
  const baseUrl = cfg.baseUrl;
  if (!apiKey || !baseUrl) return null;
  if (opts.signal?.aborted) return null;
  const post = opts.httpPost ?? httpPostJson;
  const timeoutMs = Math.max(1, opts.timeoutMs ?? TTS_DEFAULTS.timeoutMs);
  const model = cfg.model ?? TTS_DEFAULTS.model;
  const chars = textLength(text);
  const started = Date.now();
  let reported = false;

  const fail = (reason: string): null => {
    if (!reported) {
      reported = true;
      opts.log?.(`[tts] fish 合成失败（${reason}，${chars} 字，模型 ${model}，${Date.now() - started}ms）`);
    }
    return null;
  };

  // 超时/中断再兜一层：注入的传输层可能不理会 signal。
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) controller.abort();

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });

  const work = (async (): Promise<Buffer | null> => {
    try {
      const result = await post({
        url: `${baseUrl.replace(/\/+$/, "")}/v1/tts`,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          // fish 只认请求头里的模型名：放进 body 会被忽略并回 402。
          model,
        },
        body: JSON.stringify({
          text,
          reference_id: cfg.voiceId ?? TTS_DEFAULTS.voiceId,
          format: cfg.format ?? TTS_DEFAULTS.format,
        }),
        proxy: cfg.proxy ?? TTS_DEFAULTS.proxy,
        timeoutMs,
        signal: controller.signal,
      });
      if (!result || result.status < 200 || result.status >= 300) return fail(`HTTP ${result?.status ?? "无响应"}`);
      const body = result.body;
      if (!body || body.length === 0) return fail("空响应");
      if (looksLikeJsonBody(body)) return fail("响应为 JSON 而非音频");
      return body;
    } catch (err) {
      return fail(errorKind(err));
    }
  })();

  try {
    const result = await Promise.race([work, timeout]);
    if (result === null && timedOut) return fail("超时");
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 合成入口：按 provider 分派。
 * minimax 走原 T2A v2（hex 解码）；fish 走 /v1/tts（音频二进制）。
 */
export async function synthesizeMp3(
  cfg: TtsConfig,
  text: string,
  opts: SynthesizeOptions = {},
): Promise<Buffer | null> {
  try {
    if (cfg.provider === "fish") return await synthesizeFish(cfg, text, opts);
  } catch {
    return null;
  }
  // 以下为 MiniMax 原逻辑，行为保持不变。
  try {
    const apiKey = cfg.apiKey;
    const baseUrl = cfg.baseUrl;
    if (!apiKey || !baseUrl) return null;
    const fetchImpl = opts.fetchImpl
      ?? (globalThis.fetch as unknown as TtsFetch | undefined);
    if (!fetchImpl) return null;
    if (opts.signal?.aborted) return null;

    const timeoutMs = Math.max(1, opts.timeoutMs ?? TTS_DEFAULTS.timeoutMs);
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) controller.abort();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });

    const work = (async (): Promise<Buffer | null> => {
      const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/t2a_v2`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.model ?? TTS_DEFAULTS.model,
          text,
          stream: false,
          voice_setting: {
            voice_id: cfg.voiceId ?? TTS_DEFAULTS.voiceId,
            speed: cfg.speed ?? TTS_DEFAULTS.speed,
            vol: cfg.vol ?? TTS_DEFAULTS.vol,
            pitch: cfg.pitch ?? TTS_DEFAULTS.pitch,
          },
          audio_setting: {
            sample_rate: 32000,
            bitrate: 128000,
            format: cfg.format ?? TTS_DEFAULTS.format,
            channel: 1,
          },
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as TtsResponseBody | null;
      if (!body || body.base_resp?.status_code !== 0) return null;
      const hex = body.data?.audio;
      if (typeof hex !== "string") return null;
      const compact = hex.replace(/\s+/g, "");
      if (!compact) return null;
      const audio = Buffer.from(compact, "hex");
      return audio.length ? audio : null;
    })().catch(() => null);

    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  } catch {
    return null;
  }
}

export interface VoiceSendDeps {
  /** 真正发出语音；返回 false 表示明确失败。允许抛异常，内部会兜住。 */
  sendRecord(groupId: string, audio: Buffer): Promise<boolean>;
  fetchImpl?: TtsFetch;
  /** fish provider 的传输层注入点（自测用）。 */
  httpPost?: HttpPost;
  random?: () => number;
  log?: (message: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface VoiceSendResult {
  sent: boolean;
  reason?: string;
}

/**
 * 发送前决定形态的完整流程：判定 → 合成 → 发送。
 * 任何一步失败都返回 sent=false，由调用方继续发原来的文字。
 */
export async function trySendVoice(opts: {
  cfg?: TtsConfig | null;
  groupId: string;
  isEntertainmentGroup: boolean;
  text: string;
  deps: VoiceSendDeps;
}): Promise<VoiceSendResult> {
  try {
    const cfg = opts.cfg ?? undefined;
    const plan = planVoice({
      cfg,
      isEntertainmentGroup: opts.isEntertainmentGroup,
      text: opts.text,
      random: opts.deps.random,
    });
    if (!plan.speak) {
      // 关闭是常态，不打日志；开着但被过滤/未命中时留一条短因由。
      if (cfg?.enabled === true && plan.reason !== "未命中概率") {
        opts.deps.log?.(`[tts] 跳过（${plan.reason}）`);
      }
      return { sent: false, reason: plan.reason };
    }
    if (opts.deps.signal?.aborted) return { sent: false, reason: "已取消" };

    const model = cfg?.model ?? TTS_DEFAULTS.model;
    const length = opts.text.trim().length;
    const started = Date.now();
    const audio = await synthesizeMp3(cfg!, opts.text, {
      fetchImpl: opts.deps.fetchImpl,
      httpPost: opts.deps.httpPost,
      log: opts.deps.log,
      timeoutMs: opts.deps.timeoutMs,
      signal: opts.deps.signal,
    });
    const elapsed = Date.now() - started;
    if (!audio) {
      opts.deps.log?.(`[tts] 合成失败，回退文字（${length} 字，模型 ${model}，${elapsed}ms）`);
      return { sent: false, reason: "合成失败" };
    }
    if (opts.deps.signal?.aborted) {
      opts.deps.log?.(`[tts] 已取消，回退文字（${length} 字，模型 ${model}，合成 ${elapsed}ms）`);
      return { sent: false, reason: "已取消" };
    }
    try {
      const ok = await opts.deps.sendRecord(opts.groupId, audio);
      if (!ok) {
        opts.deps.log?.(`[tts] 语音发送失败，回退文字（${length} 字，模型 ${model}，合成 ${elapsed}ms）`);
        return { sent: false, reason: "发送失败" };
      }
      opts.deps.log?.(`[tts] 已发送语音（${length} 字，模型 ${model}，合成 ${elapsed}ms）`);
      return { sent: true };
    } catch {
      opts.deps.log?.(`[tts] 语音发送异常，回退文字（${length} 字，模型 ${model}，合成 ${elapsed}ms）`);
      return { sent: false, reason: "发送失败" };
    }
  } catch {
    return { sent: false, reason: "异常" };
  }
}
