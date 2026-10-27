import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  VOICE_PRESETS,
  VOICE_TOOL_MAX_CHARS,
  resolveVoiceId,
  runVoiceSend,
  sanitizeSpeakText,
  type VoiceToolInput,
} from "../src/voice-tool.ts";
import { TTS_DEFAULTS, type TtsConfig, type TtsFetch, type TtsFetchInit, type TtsHttpResponse } from "../src/tts.ts";

/**
 * voice_send 自测：合成与发送全部是 mock，不调用 MiniMax、不连接 QQ。
 * sendRecord 就是"假 OneBot"：只校验桥接交给它的群号与音频，不产生任何外部副作用。
 */

const FAKE_KEY = "selftest-fake-key";
const FAKE_BASE = "https://tts.example.invalid/";
const OWNER = "12345";
const WHITELIST_USER = "23456";
const STRANGER = "34567";
const GROUP = "45678";
const SPEAKABLE = "今天下午只有一节高数和一节英语";
const LONG_TEXT = "念".repeat(VOICE_TOOL_MAX_CHARS + 1);
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
  allowOthers: false,
};

const SECRET_HINTS = [FAKE_KEY];

function reply(body: unknown, status = 200): TtsHttpResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function okFetch(options: {
  capture?: (url: string, init: TtsFetchInit) => void;
  audio?: string;
  status?: number;
  body?: unknown;
} = {}): TtsFetch {
  return async (url, init) => {
    options.capture?.(url, init);
    if (options.status !== undefined && options.status !== 200) return reply({}, options.status);
    return reply(options.body ?? { base_resp: { status_code: 0 }, data: { audio: options.audio ?? AUDIO_HEX.toUpperCase() } });
  };
}

interface Harness {
  fetches: Array<{ url: string; body: Record<string, unknown> }>;
  sends: Array<{ groupId: string; audio: Buffer }>;
  logs: string[];
}

/** 构造一次工具调用：默认院长、娱乐模式群、正常配置。 */
function call(
  overrides: Partial<VoiceToolInput> = {},
  deps: {
    fetchImpl?: TtsFetch;
    sendRecord?: (groupId: string, audio: Buffer) => Promise<boolean>;
    signal?: AbortSignal;
  } = {},
): { promise: ReturnType<typeof runVoiceSend>; harness: Harness } {
  const harness: Harness = { fetches: [], sends: [], logs: [] };
  const input: VoiceToolInput = {
    cfg: CFG,
    isEntertainmentGroup: true,
    asker: OWNER,
    owner: OWNER,
    whitelist: [OWNER, WHITELIST_USER],
    text: SPEAKABLE,
    voice: undefined,
    ...overrides,
  };
  const capture = (url: string, init: TtsFetchInit): void => {
    harness.fetches.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
  };
  const promise = runVoiceSend({
    groupId: GROUP,
    input,
    deps: {
      fetchImpl: deps.fetchImpl ?? okFetch({ capture }),
      sendRecord: deps.sendRecord ?? (async (groupId, audio) => {
        harness.sends.push({ groupId, audio });
        return true;
      }),
      signal: deps.signal,
      log: (m) => harness.logs.push(m),
    },
  });
  return { promise, harness };
}

function assertNoSecret(logs: string[]): void {
  const joined = logs.join("\n");
  for (const secret of SECRET_HINTS) assert.equal(joined.includes(secret), false, "日志不得包含密钥");
  assert.equal(joined.includes(SPEAKABLE), false, "日志不得包含朗读文本全文");
}

/** 扩展侧自测：voice-tools.ts 只做 HTTP 转发，这里用本地回环服务代替桥接。 */
async function extensionForwardingTest(): Promise<void> {
  const token = "a".repeat(64);
  const received: Array<{ url?: string; auth?: string; body?: string }> = [];
  let replyText = "语音已发出（测试）";
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      received.push({ url: req.url, auth: String(req.headers.authorization ?? ""), body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, text: replyText }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  process.env.QQ_VOICE_ENDPOINT = `http://127.0.0.1:${addr.port}/voice-send`;
  process.env.QQ_VOICE_TOKEN = token;
  try {
    const mod = await import("../sandbox/.pi/extensions/voice-tools.ts");
    const tools: Array<{
      name: string;
      description: string;
      parameters: { required?: string[] };
      execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }>;
    }> = [];
    mod.default({ registerTool: (tool: (typeof tools)[number]) => tools.push(tool) });
    assert.equal(tools.length, 1, "扩展应只注册一个工具");
    const tool = tools[0];
    assert.equal(tool.name, "voice_send");
    assert.deepEqual(tool.parameters.required, ["text"]);
    assert.ok(tool.description.includes("娱乐模式") && tool.description.includes("长文"), "描述应说明可用范围与限制");

    const ok = await tool.execute("call-1", { text: "念一下明天的课", voice: "御姐" });
    assert.equal(ok.content[0].text, replyText);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, "/voice-send");
    assert.equal(received[0].auth, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(received[0].body ?? ""), { text: "念一下明天的课", voice: "御姐" });

    replyText = "语音没有发出：仅院长可指定语音。";
    const denied = await tool.execute("call-2", { text: "念" });
    assert.ok(denied.content[0].text.includes("仅院长"), "应如实回传桥接的拒绝原因");

    delete process.env.QQ_VOICE_ENDPOINT;
    const before = received.length;
    const noEnv = await tool.execute("call-3", { text: "念" });
    assert.ok(noEnv.content[0].text.includes("没有语音权限"));
    assert.equal(received.length, before, "没有凭据时不得发出请求");
  } finally {
    delete process.env.QQ_VOICE_ENDPOINT;
    delete process.env.QQ_VOICE_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  console.log("PASS extension: voice-tools 转发 text/voice，缺凭据时本地拒绝");
}


async function main(): Promise<void> {
  assert.equal(VOICE_TOOL_MAX_CHARS, 200);
  console.log("PASS limit: 工具上限 200 字（与自动钩子的 maxChars 独立）");

  await extensionForwardingTest();

  // ── 音色白名单：中文名/voice_id 双向命中 ──
  const expected: Record<string, string> = {
    少女: "female-shaonv",
    御姐: "female-yujie",
    成熟女性: "female-chengshu",
    甜美: "female-tianmei",
    青涩青年: "male-qn-qingse",
    精英青年: "male-qn-jingying",
    霸道青年: "male-qn-badao",
    青年大学生: "male-qn-daxuesheng",
    萌女童: "lovely_girl",
    男童: "cute_boy",
  };
  assert.equal(VOICE_PRESETS.length, Object.keys(expected).length, "白名单条目数应为 10");
  for (const [name, id] of Object.entries(expected)) {
    assert.equal(VOICE_PRESETS.find((p) => p.name === name)?.id, id, `白名单缺少 ${name}`);
    assert.deepEqual(resolveVoiceId(name, "female-shaonv"), { voiceId: id, name, matched: true }, `中文名 ${name} 未命中`);
    assert.deepEqual(resolveVoiceId(id, "female-shaonv"), { voiceId: id, name, matched: true }, `voice_id ${id} 未命中`);
    assert.deepEqual(resolveVoiceId(id.toUpperCase(), "female-shaonv"), { voiceId: id, name, matched: true }, `大写 voice_id ${id} 未命中`);
  }
  const unknown = resolveVoiceId("宇宙第一音色", "female-shaonv");
  assert.deepEqual(unknown, { voiceId: "female-shaonv", name: "少女", matched: false }, "未知音色应静默回退默认");
  assert.deepEqual(resolveVoiceId("", "female-tianmei"), { voiceId: "female-tianmei", name: "甜美", matched: false });
  assert.deepEqual(resolveVoiceId(undefined, "not-a-voice"), { voiceId: "not-a-voice", name: "not-a-voice", matched: false });
  assert.deepEqual(resolveVoiceId(undefined, undefined), { voiceId: TTS_DEFAULTS.voiceId, name: "少女", matched: false });
  assert.deepEqual(resolveVoiceId(123 as unknown as string, "female-shaonv"), { voiceId: "female-shaonv", name: "少女", matched: false });
  console.log("PASS voices: 中文名 / voice_id 命中，未知音色回退 tts.voiceId");

  // ── 文本清洗：Markdown、代码、链接不朗读 ──
  assert.equal(sanitizeSpeakText("**明天** 上 `高数` 课"), "明天 上 高数 课");
  assert.equal(sanitizeSpeakText("看这个 https://example.com/a?b=1 就行"), "看这个 就行");
  assert.equal(sanitizeSpeakText("说明：\n```js\nconsole.log(1)\n```\n完"), "说明： 完");
  assert.equal(sanitizeSpeakText("- 第一点\n- 第二点"), "第一点 第二点");
  assert.equal(sanitizeSpeakText("   \n\n  "), "");
  console.log("PASS sanitize: Markdown/代码/链接被清洗，多行压成一行");

  // ── 正常路径：合成并发送到当前群 ──
  {
    const { promise, harness } = call();
    const result = await promise;
    assert.equal(result.ok, true, result.text);
    assert.equal(harness.fetches.length, 1, "应只调用一次合成接口");
    assert.equal(harness.fetches[0].url, `${FAKE_BASE.replace(/\/+$/, "")}/v1/t2a_v2`);
    assert.equal(harness.fetches[0].body.text, SPEAKABLE);
    assert.equal((harness.fetches[0].body.voice_setting as Record<string, unknown>).voice_id, "female-shaonv");
    assert.equal(harness.sends.length, 1, "应只发送一次语音");
    assert.equal(harness.sends[0].groupId, GROUP);
    assert.deepEqual(harness.sends[0].audio, AUDIO);
    assert.equal(result.chars, SPEAKABLE.length);
    assert.equal(result.voiceId, "female-shaonv");
    assert.equal(result.voiceName, "少女");
    assert.ok(typeof result.elapsedMs === "number" && result.elapsedMs >= 0);
    assert.ok(result.text.includes("少女") && result.text.includes("female-shaonv"), "成功信息应带音色");
    assert.ok(result.text.includes(`${SPEAKABLE.length} 字`), "成功信息应带字数");
    assert.ok(/不要再发任何文字/.test(result.text), "应提醒本轮不再补发文字");
    assertNoSecret(harness.logs);
    assert.ok(harness.logs.some((l) => l.includes("已发送语音") && !l.includes(SPEAKABLE)));
    console.log("PASS ok: 合成并发送到当前群，返回音色/字数/耗时");
  }

  // ── 白名单用户与非授权用户 ──
  {
    const { promise, harness } = call({ asker: WHITELIST_USER });
    const result = await promise;
    assert.equal(result.ok, true, "白名单用户应可使用");
    assert.equal(harness.sends.length, 1);
    console.log("PASS whitelist: bot.whitelist 里的用户可直接指定语音");
  }
  {
    const { promise, harness } = call({ asker: STRANGER });
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "无权限");
    assert.ok(result.text.includes("仅院长可指定语音"), result.text);
    assert.equal(harness.fetches.length, 0, "拒绝时不得调用合成接口");
    assert.equal(harness.sends.length, 0, "拒绝时不得发送语音");
    console.log("PASS deny: 非 owner/非白名单 → 仅院长可指定语音，零副作用");
  }

  // ── allowOthers=true 时放行 ──
  {
    const { promise, harness } = call({ asker: STRANGER, cfg: { ...CFG, allowOthers: true } });
    const result = await promise;
    assert.equal(result.ok, true, result.text);
    assert.equal(harness.sends.length, 1);
    console.log("PASS allowOthers: allowOthers=true 时其他群友也能指定语音");
  }
  {
    const { promise } = call({ asker: STRANGER, cfg: { ...CFG, allowOthers: false } });
    assert.equal((await promise).ok, false, "显式 false 与缺省一致");
    console.log("PASS allowOthers=false: 与缺省行为一致");
  }

  // ── 非娱乐模式 / 语音关闭 / 配置缺失 ──
  {
    const { promise, harness } = call({ isEntertainmentGroup: false });
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "非娱乐群");
    assert.ok(result.text.includes("只有娱乐模式群"), result.text);
    assert.equal(harness.fetches.length + harness.sends.length, 0);
    console.log("PASS mode: 非娱乐模式群 → 只有娱乐模式群可用，零副作用");
  }
  {
    const { promise, harness } = call({ cfg: { ...CFG, enabled: false } });
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "语音未开启");
    assert.equal(harness.fetches.length + harness.sends.length, 0);
    console.log("PASS disabled: tts 关闭 → ok:false，不合成不发送");
  }
  {
    const { promise, harness } = call({ cfg: null });
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "语音未开启");
    assert.equal(harness.fetches.length + harness.sends.length, 0);
    console.log("PASS no-config: 缺 tts 配置 → ok:false");
  }
  {
    const { promise } = call({ cfg: { ...CFG, apiKey: "" } });
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "配置不完整");
    console.log("PASS incomplete: 缺 apiKey → 配置不完整");
  }

  // ── 超长 / 空文本 ──
  {
    const { promise, harness } = call({ text: LONG_TEXT });
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "超长");
    assert.ok(result.text.includes("太长") && result.text.includes("200"), result.text);
    assert.equal(harness.fetches.length + harness.sends.length, 0);
    console.log("PASS long: 超过 200 字 → ok:false 并提示缩短");
  }
  {
    const { promise, harness } = call({ text: `\`\`\`js\nconsole.log(1)\n\`\`\` https://example.com` });
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "空文本");
    assert.equal(harness.fetches.length + harness.sends.length, 0);
    console.log("PASS empty: 只有代码/链接 → 没有可朗读的文字");
  }

  // ── 音色选择真的传到接口 ──
  {
    const { promise, harness } = call({ voice: "御姐" });
    const result = await promise;
    assert.equal(result.ok, true);
    assert.equal(result.voiceId, "female-yujie");
    assert.equal(result.voiceName, "御姐");
    assert.equal((harness.fetches[0].body.voice_setting as Record<string, unknown>).voice_id, "female-yujie");
    console.log("PASS voice-param: 中文音色名 → 对应 voice_id 传给接口");
  }
  {
    const { promise, harness } = call({ voice: "not-a-real-voice" });
    const result = await promise;
    assert.equal(result.ok, true);
    assert.equal(result.voiceId, CFG.voiceId, "未知音色应回退默认，不应把无效 id 发给接口");
    assert.equal((harness.fetches[0].body.voice_setting as Record<string, unknown>).voice_id, CFG.voiceId);
    console.log("PASS voice-fallback: 未知音色回退 tts.voiceId 再调接口");
  }

  // ── 合成失败 / 发送失败 / 取消 ──
  {
    const { promise, harness } = call({}, { fetchImpl: okFetch({ status: 500 }) });
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "合成失败");
    assert.ok(result.text.includes("语音合成失败"), result.text);
    assert.equal(harness.sends.length, 0, "合成失败不得发送");
    assert.ok(harness.logs.some((l) => l.includes("合成失败") && !l.includes(SPEAKABLE)));
    console.log("PASS synth-fail: 非 2xx → ok:false，不发送");
  }
  {
    const { promise } = call({}, {
      fetchImpl: okFetch({ body: { base_resp: { status_code: 1004 }, data: {} } }),
    });
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "合成失败");
    console.log("PASS synth-fail-code: base_resp 非 0 → ok:false");
  }
  {
    const { promise } = call({}, {
      fetchImpl: async () => { throw new Error("network down"); },
    });
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "合成失败");
    console.log("PASS synth-fail-net: 网络异常 → ok:false");
  }
  for (const mode of ["false", "throw"] as const) {
    const { promise, harness } = call({}, {
      sendRecord: async () => {
        if (mode === "throw") throw new Error("onebot down");
        return false;
      },
    });
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "发送失败");
    assert.ok(result.text.includes("语音发送失败"), result.text);
    assert.equal(harness.fetches.length, 1, "发送失败前合成已完成");
    assert.ok(harness.logs.some((l) => l.includes("发送失败") && !l.includes(SPEAKABLE)));
    console.log(`PASS send-fail(${mode}): 发送返回 false/抛异常 → ok:false`);
  }
  {
    const controller = new AbortController();
    controller.abort();
    const { promise, harness } = call({}, { signal: controller.signal });
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(result.reason, "已取消");
    assert.equal(harness.fetches.length + harness.sends.length, 0);
    console.log("PASS aborted: 回合已取消 → 不合成不发送");
  }

  // ── 发送目标就是当前群（群号由桥接绑定，工具参数无法指定别的群） ──
  {
    const { promise, harness } = call({});
    await promise;
    assert.deepEqual(harness.sends.map((s) => s.groupId), [GROUP]);
    console.log("PASS target: 语音只发到桥接绑定的当前群");
  }

  console.log("voice-send-selftest: all passed（mock fetch 与假 OneBot；未调用 MiniMax、未连接 QQ）");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
