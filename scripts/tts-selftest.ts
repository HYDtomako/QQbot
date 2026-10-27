import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import {
  planVoice,
  synthesizeMp3,
  trySendVoice,
  voiceTextRejection,
  TTS_DEFAULTS,
  type TtsConfig,
  type TtsFetch,
  type TtsFetchInit,
  type TtsHttpResponse,
} from "../src/tts.ts";

/**
 * TTS 自测：所有 fetch 与消息发送都是 mock。
 * 严禁真实调用 MiniMax（会花额度），严禁发真实 QQ 消息。
 */

const FAKE_KEY = "selftest-fake-key";
const FAKE_BASE = "https://tts.example.invalid/";
const SPEAKABLE = "今天晚上吃什么呀";
const AUDIO = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb]);
const AUDIO_HEX = AUDIO.toString("hex");

const CFG: TtsConfig = {
  enabled: true,
  apiKey: FAKE_KEY,
  baseUrl: FAKE_BASE,
  model: TTS_DEFAULTS.model,
  voiceId: TTS_DEFAULTS.voiceId,
  speed: 1,
  vol: 1,
  pitch: 0,
  probability: 0.35,
  maxChars: 80,
  format: "mp3",
};

function reply(body: unknown, status = 200): TtsHttpResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function okFetch(options: { capture?: (url: string, init: TtsFetchInit) => void; audio?: string } = {}): TtsFetch {
  return async (url, init) => {
    options.capture?.(url, init);
    return reply({ base_resp: { status_code: 0 }, data: { audio: options.audio ?? AUDIO_HEX.toUpperCase() } });
  };
}

function assertNoSecretOrText(logs: string[], text: string): void {
  const joined = logs.join("\n");
  assert.equal(joined.includes(FAKE_KEY), false, "日志不得包含密钥");
  assert.equal(joined.includes(text), false, "日志不得包含文本全文");
}

async function main(): Promise<void> {
  // 兜底：任何漏配 fetch 的路径立刻失败，而不是真的走网络。
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("selftest 禁止真实网络请求");
  }) as typeof fetch;

  const temp = mkdtempSync(path.join(tmpdir(), "tts-selftest-"));
  try {
    // ── 配置加载：没有 tts 段不报错；有 tts 段按可选字段读取 ──
    const base = {
      onebot: { wsUrl: "ws://127.0.0.1:0", token: "synthetic" },
      bot: { selfId: "1", nickname: "测试", owner: "2", whitelist: [], atAliases: [], maxConcurrent: 1, timeoutMs: 1000 },
      pi: { command: "node", args: [], thinking: "" },
    };
    const noTts = path.join(temp, "no-tts.json");
    writeFileSync(noTts, JSON.stringify({ ...base, entertainment: { replyFrequency: 0.3 } }));
    assert.equal(loadConfig(noTts).entertainment?.tts, undefined);

    const withTts = path.join(temp, "tts.json");
    writeFileSync(withTts, JSON.stringify({
      ...base,
      entertainment: { tts: { enabled: true, apiKey: FAKE_KEY, baseUrl: FAKE_BASE, probability: 0.35, maxChars: 80 } },
    }));
    const loaded = loadConfig(withTts).entertainment?.tts;
    assert.equal(loaded?.enabled, true);
    assert.equal(loaded?.baseUrl, FAKE_BASE);
    assert.equal(loaded?.maxChars, 80);
    console.log("PASS config: 缺 tts 段不报错，tts 字段按可选读取");

    // ── 文本过滤 ──
    assert.equal(voiceTextRejection(SPEAKABLE, 80), null);
    assert.equal(voiceTextRejection("哈哈哈哈太真实了", 80), null);
    assert.equal(voiceTextRejection("今天好热，记得多喝水。", 80), null);
    const rejected: Array<[string, string]> = [
      ["", "空文本"],
      ["a".repeat(81), "超长"],
      ["第一行\n第二行", "多行"],
      ["```ts\nconst a = 1\n```", "多行"],
      ["用 `const a = 1` 试试", "代码"],
      ["看看 https://example.com/a 这个", "链接"],
      ["@小明 你来说", "@提及"],
      ["[图片1：一只猫]", "媒体标记"],
      ["│ 周一 │ 周二 │ 周三 │", "面板符号"],
      ["第一句。第二句。第三句。", "句子过多"],
      ["😀😀😀", "符号过多"],
      ["📊📈📉", "符号过多"],
    ];
    for (const [text, why] of rejected) {
      assert.equal(voiceTextRejection(text, 80), why, `应拒绝：${why}`);
    }
    assert.equal(voiceTextRejection("超出默认上限", 2), "超长");
    console.log("PASS filter: 空/超长/多行/代码/链接/@/媒体标记/面板/多句/符号堆全部拒绝");

    // ── 发送前决策 ──
    assert.deepEqual(planVoice({ cfg: undefined, isEntertainmentGroup: true, text: SPEAKABLE }), { speak: false, reason: "关闭" });
    assert.equal(planVoice({ cfg: { ...CFG, enabled: false }, isEntertainmentGroup: true, text: SPEAKABLE }).reason, "关闭");
    assert.equal(planVoice({ cfg: CFG, isEntertainmentGroup: false, text: SPEAKABLE }).reason, "非娱乐群");
    assert.equal(planVoice({ cfg: { ...CFG, apiKey: undefined }, isEntertainmentGroup: true, text: SPEAKABLE }).reason, "配置不完整");
    assert.equal(planVoice({ cfg: CFG, isEntertainmentGroup: true, text: "看看 https://example.com/a" }).reason, "链接");
    assert.equal(planVoice({ cfg: CFG, isEntertainmentGroup: true, text: SPEAKABLE, random: () => 0.35 }).reason, "未命中概率");
    assert.equal(planVoice({ cfg: CFG, isEntertainmentGroup: true, text: SPEAKABLE, random: () => 0.34 }).speak, true);
    assert.equal(planVoice({ cfg: { ...CFG, probability: 1 }, isEntertainmentGroup: true, text: SPEAKABLE, random: () => 0.999 }).speak, true);
    assert.equal(planVoice({ cfg: { ...CFG, probability: 0 }, isEntertainmentGroup: true, text: SPEAKABLE, random: () => 0 }).reason, "概率为0");
    console.log("PASS plan: 关闭/非娱乐群/缺密钥/文本过滤/随机未命中均保持文字，命中才转语音");

    // ── 正常合成 ──
    let seen: { url: string; init: TtsFetchInit } | undefined;
    const audio = await synthesizeMp3(CFG, SPEAKABLE, {
      fetchImpl: okFetch({ capture: (url, init) => { seen = { url, init }; } }),
      timeoutMs: 1000,
    });
    assert.ok(audio && audio.equals(AUDIO), "应返回解码后的 mp3 字节");
    assert.equal(seen?.url, "https://tts.example.invalid/v1/t2a_v2");
    assert.equal(seen?.init.method, "POST");
    assert.equal(seen?.init.headers.Authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(seen?.init.headers["Content-Type"], "application/json");
    const body = JSON.parse(seen!.init.body) as any;
    assert.equal(body.model, "speech-2.8-turbo");
    assert.equal(body.text, SPEAKABLE);
    assert.equal(body.stream, false);
    assert.equal(body.voice_setting.voice_id, "female-shaonv");
    assert.equal(body.voice_setting.speed, 1);
    assert.equal(body.voice_setting.vol, 1);
    assert.equal(body.voice_setting.pitch, 0);
    assert.equal(body.audio_setting.format, "mp3");
    assert.equal(body.audio_setting.channel, 1);
    console.log("PASS synth: 请求地址/鉴权头/请求体符合 MiniMax T2A v2，hex 正常解码");

    // ── 各类失败都返回 null ──
    assert.equal(await synthesizeMp3(CFG, SPEAKABLE, { fetchImpl: async () => reply({ base_resp: { status_code: 1004 }, data: { audio: AUDIO_HEX } }) }), null, "base_resp 非 0");
    assert.equal(await synthesizeMp3(CFG, SPEAKABLE, { fetchImpl: async () => reply({ base_resp: { status_code: 0 }, data: { audio: "  " } }) }), null, "空音频");
    assert.equal(await synthesizeMp3(CFG, SPEAKABLE, { fetchImpl: async () => reply({ base_resp: { status_code: 0 } }) }), null, "缺 audio 字段");
    assert.equal(await synthesizeMp3(CFG, SPEAKABLE, { fetchImpl: async () => reply({}, 500) }), null, "HTTP 500");
    assert.equal(await synthesizeMp3(CFG, SPEAKABLE, { fetchImpl: async () => { throw new Error("network down"); } }), null, "网络异常");
    assert.equal(await synthesizeMp3({ ...CFG, apiKey: undefined }, SPEAKABLE, { fetchImpl: okFetch() }), null, "缺密钥");

    const timeoutStart = Date.now();
    const timedOut = await synthesizeMp3(CFG, SPEAKABLE, {
      fetchImpl: () => new Promise<TtsHttpResponse>(() => {}), // 永不返回、也不理会 abort
      timeoutMs: 60,
    });
    const timeoutElapsed = Date.now() - timeoutStart;
    assert.equal(timedOut, null, "超时必须返回 null");
    assert.ok(timeoutElapsed >= 40 && timeoutElapsed < 2000, `超时应及时返回（实际 ${timeoutElapsed}ms）`);

    const aborted = new AbortController();
    aborted.abort();
    assert.equal(await synthesizeMp3(CFG, SPEAKABLE, { fetchImpl: okFetch(), signal: aborted.signal }), null, "已取消不合成");
    console.log("PASS synth-fail: base_resp 非 0 / 空音频 / 非 2xx / 网络异常 / 缺密钥 / 超时均安静返回 null");

    // ── 完整流程：正常合成并发送 ──
    const sendCalls: Buffer[] = [];
    const happyLogs: string[] = [];
    const happy = await trySendVoice({
      cfg: CFG,
      groupId: "123456",
      isEntertainmentGroup: true,
      text: SPEAKABLE,
      deps: {
        fetchImpl: okFetch(),
        random: () => 0,
        log: (m) => happyLogs.push(m),
        sendRecord: async (_gid, mp3) => { sendCalls.push(mp3); return true; },
      },
    });
    assert.equal(happy.sent, true);
    assert.equal(sendCalls.length, 1);
    assert.ok(sendCalls[0].equals(AUDIO));
    assert.ok(happyLogs.some((l) => l.includes("已发送语音")));
    assert.ok(happyLogs.every((l) => l.includes("字") || l.includes("tts")));
    assertNoSecretOrText(happyLogs, SPEAKABLE);
    console.log("PASS flow: 命中概率后合成 mp3 并交给发送函数，日志只含字数/模型/耗时");

    // ── 随机未命中：不合成、不发送 ──
    let missFetches = 0;
    const missLogs: string[] = [];
    const miss = await trySendVoice({
      cfg: CFG,
      groupId: "123456",
      isEntertainmentGroup: true,
      text: SPEAKABLE,
      deps: {
        fetchImpl: async (url, init) => { missFetches++; return okFetch()(url, init); },
        random: () => 0.99,
        log: (m) => missLogs.push(m),
        sendRecord: async () => { throw new Error("不应发送"); },
      },
    });
    assert.equal(miss.sent, false);
    assert.equal(miss.reason, "未命中概率");
    assert.equal(missFetches, 0);
    assert.equal(missLogs.length, 0, "概率未命中属于常态，不刷日志");
    console.log("PASS random-miss: 概率未命中不合成、不发送、不刷日志");

    // ── 文本被过滤：不合成 ──
    let filteredFetches = 0;
    const filteredLogs: string[] = [];
    const filtered = await trySendVoice({
      cfg: CFG,
      groupId: "123456",
      isEntertainmentGroup: true,
      text: "看看 https://example.com/a 这个",
      deps: {
        fetchImpl: async (url, init) => { filteredFetches++; return okFetch()(url, init); },
        random: () => 0,
        log: (m) => filteredLogs.push(m),
        sendRecord: async () => { throw new Error("不应发送"); },
      },
    });
    assert.equal(filtered.sent, false);
    assert.equal(filtered.reason, "链接");
    assert.equal(filteredFetches, 0);
    assert.ok(filteredLogs.some((l) => l.includes("跳过")));
    assertNoSecretOrText(filteredLogs, "https://example.com/a");
    console.log("PASS filtered: 不适合朗读的文本直接保持文字，不发合成请求");

    // ── 合成失败 → 调用方回退文字 ──
    const fallbackLogs: string[] = [];
    let fallbackSends = 0;
    const synthFail = await trySendVoice({
      cfg: CFG,
      groupId: "123456",
      isEntertainmentGroup: true,
      text: SPEAKABLE,
      deps: {
        fetchImpl: async () => reply({ base_resp: { status_code: 1004 } }),
        random: () => 0,
        log: (m) => fallbackLogs.push(m),
        sendRecord: async () => { fallbackSends++; return true; },
      },
    });
    assert.equal(synthFail.sent, false);
    assert.equal(synthFail.reason, "合成失败");
    assert.equal(fallbackSends, 0);
    assert.ok(fallbackLogs.some((l) => l.includes("回退文字")));
    assertNoSecretOrText(fallbackLogs, SPEAKABLE);
    const deliveredAfterSynthFail = synthFail.sent ? "voice" : "text";
    assert.equal(deliveredAfterSynthFail, "text");
    console.log("PASS fallback-synth: 合成失败返回 false，调用方继续发文字");

    // ── 发送失败 → 调用方回退文字 ──
    const sendFailLogs: string[] = [];
    const sendFail = await trySendVoice({
      cfg: CFG,
      groupId: "123456",
      isEntertainmentGroup: true,
      text: SPEAKABLE,
      deps: {
        fetchImpl: okFetch(),
        random: () => 0,
        log: (m) => sendFailLogs.push(m),
        sendRecord: async () => false,
      },
    });
    assert.equal(sendFail.sent, false);
    assert.equal(sendFail.reason, "发送失败");
    assert.ok(sendFailLogs.some((l) => l.includes("语音发送失败")));
    assertNoSecretOrText(sendFailLogs, SPEAKABLE);
    assert.equal(sendFail.sent ? "voice" : "text", "text");

    const throwLogs: string[] = [];
    const sendThrows = await trySendVoice({
      cfg: CFG,
      groupId: "123456",
      isEntertainmentGroup: true,
      text: SPEAKABLE,
      deps: {
        fetchImpl: okFetch(),
        random: () => 0,
        log: (m) => throwLogs.push(m),
        sendRecord: async () => { throw new Error("ws closed"); },
      },
    });
    assert.equal(sendThrows.sent, false);
    assert.equal(sendThrows.reason, "发送失败");
    assertNoSecretOrText(throwLogs, SPEAKABLE);
    console.log("PASS fallback-send: 发送返回失败或抛异常都降级为文字，不抛未捕获异常");

    // ── 超时 / 取消 / 非娱乐群：整条链路都安静返回 false ──
    const timeoutFlow = await trySendVoice({
      cfg: CFG,
      groupId: "123456",
      isEntertainmentGroup: true,
      text: SPEAKABLE,
      deps: {
        fetchImpl: () => new Promise<TtsHttpResponse>(() => {}),
        random: () => 0,
        timeoutMs: 60,
        sendRecord: async () => { throw new Error("不应发送"); },
      },
    });
    assert.equal(timeoutFlow.sent, false);
    assert.equal(timeoutFlow.reason, "合成失败");

    const cancelController = new AbortController();
    cancelController.abort();
    const cancelled = await trySendVoice({
      cfg: { ...CFG, probability: 1 },
      groupId: "123456",
      isEntertainmentGroup: true,
      text: SPEAKABLE,
      deps: {
        fetchImpl: okFetch(),
        random: () => 0,
        signal: cancelController.signal,
        sendRecord: async () => { throw new Error("不应发送"); },
      },
    });
    assert.equal(cancelled.sent, false);
    assert.equal(cancelled.reason, "已取消");

    const notEnt = await trySendVoice({
      cfg: CFG,
      groupId: "123456",
      isEntertainmentGroup: false,
      text: SPEAKABLE,
      deps: { fetchImpl: okFetch(), random: () => 0, sendRecord: async () => { throw new Error("不应发送"); } },
    });
    assert.equal(notEnt.sent, false);
    assert.equal(notEnt.reason, "非娱乐群");
    console.log("PASS guards: 超时、已取消、非娱乐群都不发送语音");

    // ── 关闭状态下零副作用（等价于改动前的文字路径） ──
    let disabledFetches = 0;
    const disabledLogs: string[] = [];
    const disabled = await trySendVoice({
      cfg: { ...CFG, enabled: false },
      groupId: "123456",
      isEntertainmentGroup: true,
      text: SPEAKABLE,
      deps: {
        fetchImpl: async (url, init) => { disabledFetches++; return okFetch()(url, init); },
        random: () => 0,
        log: (m) => disabledLogs.push(m),
        sendRecord: async () => { throw new Error("不应发送"); },
      },
    });
    assert.equal(disabled.sent, false);
    assert.equal(disabled.reason, "关闭");
    assert.equal(disabledFetches, 0);
    assert.equal(disabledLogs.length, 0);
    console.log("PASS disabled: tts 关闭时不合成、不发送、不打日志");

    console.log("tts-selftest: all passed（全部使用 mock fetch 与 mock 发送；未调用 MiniMax、未连接 QQ）");
  } finally {
    globalThis.fetch = realFetch;
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
