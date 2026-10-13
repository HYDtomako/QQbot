import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync, renameSync, readdirSync, unlinkSync, watchFile } from "node:fs";
import { loadConfig } from "./config.ts";
import { OneBotClient, type MessageSegment } from "./onebot.ts";
import { matchMessage, type TriggeredMessage } from "./router.ts";
import { createAttachments, type MaterializedFile } from "./attachments.ts";
import { PiRunner, type PiResult } from "./runner.ts";
import { randomUUID } from "node:crypto";
import { describeEmoji, parseMessageContent } from "./message-content.ts";
import { chatDate, readRecentChat, renderChatMessage, MEDIA_CONTEXT_RULES } from "./group-chat.ts";
import { MediaContext } from "./media-context.ts";
import { ModeTurns, groupSessionKey, type ReplyTurn } from "./mode-turns.ts";
import { normalReplyText, recordedReplyText } from "./reply-policy.ts";
import { buildReply, splitForCard, splitText, textSegment, MAX_SEGMENT_LEN } from "./reply.ts";
import { Antispam } from "./antispam.ts";
import { TaskScheduler } from "./tasks.ts";
import { ensureSchedule, answerDay, setClassFilter, readCache, type ScheduleBundle } from "../schedule/zf.ts";
import { prefetchLinks } from "./linktext.ts";
import { Modes, matchModeCommand, extractGroupId } from "./modes.ts";
import { DynamicReplyGate, estimateReplyProbability } from "./gate.ts";
import { StickerLibrary, parseEntertainmentReply, stickerPrompt, type StickerEntry } from "./stickers.ts";
import { KnowledgeService } from "./knowledge/service.ts";
import type { KnowledgeTurn } from "./knowledge/types.ts";
import { normalizeKnowledgeConfig } from "./knowledge/policy.ts";
import { acceptedKnowledgeInput, isKnowledgeCommand, knowledgeContextPrompt } from "./knowledge/bridge.ts"
import { compactPaReply, needsPaCleanup, PA_REPLY_MAX_CHARS } from "./pa-format.ts";

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const config = loadConfig(path.join(root, "config.json"));
const whitelist = new Set(config.bot.whitelist);
const sandboxDir = path.join(root, "sandbox");
const modes = new Modes(path.join(root, "modes.json"));
const modeTurns = new ModeTurns(gid => modes.isEntertainment(gid));
const stickerLibrary = new StickerLibrary(path.join(root, "stickers"));

// ── 娱乐模式状态跟踪：机器人上次在每群说话的时间 ──
const groupLastBotAt = new Map<string, number>(); // 每群：机器人上次说话的时间

// ── 娱乐模式·主动插话：拿麦麦（MaiBot）的逻辑回归门控试跑（只对开了娱乐模式的群）──
const ENT_RECENT_WINDOW_MS = 300_000;
const ENT_REPLY_FREQUENCY = Math.min(1, Math.max(0, config.entertainment?.replyFrequency ?? 0.3));

interface EntState {
  gate: DynamicReplyGate;
  recent: Array<{ ts: number; isBot: boolean }>;
  pending: number;
  busy: boolean;
}
const entStates = new Map<string, EntState>();
function entState(gid: string): EntState {
  let s = entStates.get(gid);
  if (!s) {
    s = { gate: new DynamicReplyGate(), recent: [], pending: 0, busy: false };
    entStates.set(gid, s);
  }
  return s;
}

/** 从 OneBot 消息段求出 (hasQuestion, placeholderOnly, atOther)。 */
function entTextSignals(event: Record<string, unknown>): { hasQuestion: boolean; placeholderOnly: boolean; atOther: boolean } {
  const segs = Array.isArray(event.message) ? (event.message as Array<{ type: string; data?: Record<string, unknown> }>) : [];
  let text = "";
  let onlyMedia = true;
  let atOther = false;
  for (const s of segs) {
    if (s.type === "text") {
      const t = String(s.data?.text ?? "").trim();
      text += t;
      if (t) onlyMedia = false;
    } else if (s.type === "at") {
      const qq = String(s.data?.qq ?? "");
      if (qq && qq !== config.bot.selfId) atOther = true;
    } else if (["image", "face", "mface", "record", "video", "file", "forward"].includes(s.type)) {
      // 媒体类不计入“有文字”
    } else {
      onlyMedia = false;
    }
  }
  return { hasQuestion: /[?？]/.test(text), placeholderOnly: onlyMedia && segs.length > 0, atOther };
}

/** 群消息进入娱乐模式门控；addressed=这条是否冲着 bot（@了或叫了名字）。 */
function entertainmentOnGroupMessage(event: Record<string, unknown>, addressed: boolean): void {
  const gid = String(event.group_id ?? "");
  if (!gid || !modes.isEntertainment(gid)) return;
  const now = Date.now();
  const st = entState(gid);
  const cutoff = now - ENT_RECENT_WINDOW_MS;
  while (st.recent.length && st.recent[0].ts < cutoff) st.recent.shift();

  if (addressed) {
    // @ 或叫名字：强制触发（走普通问答），预计回复数按实测均值计入
    st.gate.recordForcedTurn(now);
    st.pending = 0;
    st.recent.push({ ts: now, isBot: false });
    return;
  }

  const { hasQuestion, placeholderOnly, atOther } = entTextSignals(event);
  st.pending += 1;
  st.recent.push({ ts: now, isBot: false });

  const recentSelf = st.recent.filter((r) => r.isBot).length;
  const recentCount = st.recent.length;
  const lastBot = groupLastBotAt.get(gid);
  const prob = estimateReplyProbability({
    mentionBot: false,
    atOther,
    hasQuestionMark: hasQuestion,
    placeholderOnly,
    recentSelfRatio: recentSelf / Math.max(1, recentCount),
    recentMessageCount: recentCount,
    secondsSinceBotMessage: lastBot ? (now - lastBot) / 1000 : 3600,
    pendingCount: st.pending,
  });
  st.gate.recordProactiveDemand(prob, now);
  const decision = st.gate.evaluate(prob, ENT_REPLY_FREQUENCY, now);
  if (decision.shouldTrigger && !st.busy) {
    st.gate.closeRound();
    st.pending = 0;
    proactiveSay(gid).catch((err) => log("[ent] 主动插话异常:", err));
  }
}

/** 生成并发送一句主动插话。 */
async function proactiveSay(gid: string): Promise<void> {
  const st = entState(gid);
  if (st.busy) return;
  const turn = modeTurns.begin(gid);
  if (!turn.entertainment || !turn.isCurrent()) { turn.finish(); return; }
  st.busy = true;
  try {
    let name = groupNames.get(gid);
    if (!name) name = (await client.getGroupName(gid)) ?? undefined;
    if (name) groupNames.set(gid, name);
    await waitForRecentMedia(gid);
    if (!turn.isCurrent()) return;
    const ctx = recentChatContext(gid, 20, true);
    const choices = stickerLibrary.available(gid);
    const prompt =
      `[娱乐模式·主动插话] 你是 QQ 群「${name ?? gid}」里的成员「${config.bot.nickname}」，以真实群友的口吻参与闲聊。\n` +
      `下面是群里最近的消息（标注“(你自己)”的是你说过的话）。请自然地插一句话接上话题：\n` +
      `- 一到两句、口语化、简短；\n` +
      `- 不要 @ 任何人，不要客套、不要自我介绍、不要任何格式标记；\n` +
      `- 没有合适的话、你刚说过，或别人正在聊他们自己的事时，可以沉默。\n` +
      stickerPrompt(choices) +
      `\n${MEDIA_CONTEXT_RULES}\n最近消息：\n${ctx}`;
    const result = await runner.run(prompt, { mode: "web", model: modelRegistry[currentModel], env: legacyToolEnv(), signal: turn.signal });
    if (!result.ok || !turn.isCurrent()) return;
    await sendEntertainmentReply(gid, result.text ?? "", choices, "主动插话", turn);
  } catch (err) {
    log("[ent] 主动插话失败:", err instanceof Error ? err.message : err);
  } finally {
    turn.finish();
    st.busy = false;
  }
}

/**
 * 娱乐模式回复落地：解析回复协议 → 组装文本/表情包消息 → 发送并记账。
 * 表情包按 ID 校验后发送原文件字节；图片被明确拒绝时回退纯文字；协议解析不了整条放弃。
 */
async function sendEntertainmentReply(gid: string, raw: string, choices: StickerEntry[], label: string, turn: ReplyTurn): Promise<void> {
  if (!turn.entertainment || !turn.isCurrent()) return;
  const reply = parseEntertainmentReply(raw);
  if (!reply.valid) {
    log(`[ent] 忽略无法解析的回复 -> 群 ${gid}`);
    return;
  }
  const text = redactSensitive(stripMarkdown(reply.text)).trim();
  let sticker = reply.sticker ? choices.find((c) => c.id === reply.sticker) : undefined;
  let image: MessageSegment | undefined;
  if (sticker) {
    try {
      image = stickerLibrary.image(sticker);
    } catch {
      log(`[ent] 表情包不可用，回退文字 -> 群 ${gid}: ${sticker.id}`);
      sticker = undefined;
    }
  }
  if (!text && !image) {
    log(`[ent] 放弃插话 -> 群 ${gid}`);
    return;
  }
  try {
    if (!image && text.length > MAX_SEGMENT_LEN) {
      // 纯文字超长时按普通分片发送；带图的消息文字很短，不需要分片
      for (const chunk of splitText(text)) {
        if (!turn.isCurrent()) return;
        await client.sendMessage({ message_type: "group", group_id: gid, message: [textSegment(chunk)] });
      }
    } else {
      let sent = await client.sendMessage({
        message_type: "group",
        group_id: gid,
        message: [...(text ? [textSegment(text)] : []), ...(image ? [image] : [])],
      });
      // 超时或断线无法确认送达，只对明确的 API 拒绝回退，避免重复发送
      if ((sent.status !== "ok" || sent.retcode !== 0) && image && text) {
        if (!turn.isCurrent()) return;
        log(`[ent] 图片发送被拒绝，回退文字 -> 群 ${gid}`);
        sent = await client.sendMessage({ message_type: "group", group_id: gid, message: [textSegment(text)] });
        sticker = undefined;
      }
      if (sent.status !== "ok" || sent.retcode !== 0) {
        log(`[ent] ${label}发送失败 -> 群 ${gid}: retcode=${sent.retcode}`);
        return;
      }
    }
    const ts = Date.now();
    const st = entStates.get(gid);
    if (st) {
      st.recent.push({ ts, isBot: true });
      st.gate.recordReply(ts);
    }
    groupLastBotAt.set(gid, ts);
    stickerLibrary.recordSent(gid, sticker?.id ?? null, ts);
    const content = [text, sticker ? `[表情包:${sticker.name} (${sticker.id})]` : ""].filter(Boolean).join(" ");
    writeChatLine(gid, config.bot.selfId, config.bot.nickname, content, true);
    log(`[ent] ${label} -> 群 ${gid}: ${content.slice(0, 80)}`);
  } catch (err) {
    log(`[ent] ${label}失败:`, err instanceof Error ? err.message : err);
  }
}

/** 异步图片摘要合并回原发言；跨午夜保留前一天的近期消息。 */
function recentChatContext(gid: string, limit: number, entertainment: boolean): string {
  try {
    const entries = readRecentChat(chatLogDir, gid, limit)
      .filter(e => e.entertainment === entertainment);
    const out = entries.map(e => {
      const isBot = e.u === config.bot.selfId;
      const who = isBot ? "(你自己)" : `${e.n || e.u}（QQ ${e.u}）`;
      const description = e.id ? mediaContext.getDescriptions(gid, e.id) : [];
      const text = renderChatMessage(e, description);
      const content = isBot ? recordedReplyText(text) : text;
      return content ? `[${e.t}${e.id ? ` 消息 ${e.id}` : ""}] ${who}: ${content}` : "";
    }).filter(Boolean);
    const selected: string[] = [];
    let chars = 0;
    for (const line of out.reverse()) {
      const bounded = line.slice(0, 4000);
      if (chars + bounded.length > 16_000) break;
      selected.unshift(bounded);
      chars += bounded.length;
    }
    return selected.length ? selected.join("\n") : "(暂无记录)";
  } catch {
    return "(读取失败)";
  }
}

async function waitForRecentMedia(gid: string, userId?: string): Promise<void> {
  if (config.entertainment?.media?.enabled === false) return;
  const cutoff = Date.now() - 3 * 60_000;
  const ids = readRecentChat(chatLogDir, gid, 20)
    .filter(e => e.id && e.mediaCount && Date.parse(e.t) >= cutoff && (!userId || e.u === userId))
    .map(e => e.id!);
  if (ids.length) await mediaContext.waitFor(gid, ids, 12_000);
}

const client = new OneBotClient(config.onebot.wsUrl, config.onebot.token);
const piEnv = {
  ...(config.pi.tavilyKey ? { TAVILY_API_KEY: config.pi.tavilyKey } : {}),
  ...(config.pi.aliyunKey ? { ALIYUN_MAA_API_KEY: config.pi.aliyunKey } : {}),
  ...(config.pi.aliyunBaseUrl ? { ALIYUN_MAA_BASE_URL: config.pi.aliyunBaseUrl } : {}),
  ...(config.web?.maxTextChars ? { WEB_MAX_TEXT_CHARS: String(config.web.maxTextChars) } : {}),
};
const runner = new PiRunner({
  command: config.pi.command,
  args: config.pi.args,
  thinking: config.pi.thinking,
  env: piEnv,
  cwd: sandboxDir,
  maxConcurrent: config.bot.maxConcurrent,
  timeoutMs: config.bot.timeoutMs,
});

// ── 模型选择：别名 -> pi --model 规格；状态持久化到 .model-state.json ──
const modelRegistry = config.pi.models ?? {};
const defaultModel = config.pi.defaultModel && modelRegistry[config.pi.defaultModel]
  ? config.pi.defaultModel
  : Object.keys(modelRegistry)[0] ?? "";
const modelStatePath = path.join(root, ".model-state.json");

function loadCurrentModel(): string {
  try {
    const saved = JSON.parse(readFileSync(modelStatePath, "utf8")).alias;
    if (modelRegistry[saved]) return saved;
  } catch {
    /* 无状态文件或损坏 → 用默认 */
  }
  return defaultModel;
}

let currentModel = loadCurrentModel();

const knowledgePath = path.join(root, "memory", "knowledge.sqlite");
const knowledge = config.knowledge !== undefined || existsSync(knowledgePath)
  ? new KnowledgeService({
      dbPath: knowledgePath,
      legacyDir: path.join(root, "memory", "long-term"),
      config: normalizeKnowledgeConfig(config.knowledge, config.bot.whitelist),
      ownerId: config.bot.owner,
      whitelist: config.bot.whitelist,
      isNormal: (scope) => !scope.startsWith("group:") || !modes.isEntertainment(scope.slice(6)),
      runModel: (prompt, signal) => runner.run(prompt, {
        mode: "none", model: modelRegistry[currentModel], priority: "background", timeoutMs: 60000, signal,
      }),
      log,
    })
  : undefined;
if (knowledge) await knowledge.start();

function legacyToolEnv(): Record<string, string> {
  const rows = knowledge?.store.db.prepare("SELECT scope FROM scope_policies WHERE ever_enabled=1").all() as { scope: string }[] | undefined;
  return {
    QQ_BOT_SELF_ID: config.bot.selfId,
    QQ_KNOWLEDGE_PROTECTED_GROUPS: JSON.stringify([...new Set([
      ...(config.knowledge?.enabled ? config.knowledge.groups ?? [] : []),
      ...(rows ?? []).filter(r => r.scope.startsWith("group:")).map(r => r.scope.slice(6)),
    ])]),
    QQ_KNOWLEDGE_PROTECTED_USERS: JSON.stringify([...new Set([
      ...(config.knowledge?.enabled ? config.knowledge.privateUsers ?? [] : []),
      ...(rows ?? []).filter(r => r.scope.startsWith("private:")).map(r => r.scope.slice(8)),
    ])]),
  };
}

function setCurrentModel(alias: string): void {
  currentModel = alias;
  writeFileSync(modelStatePath, JSON.stringify({ alias }, null, 2));
}

/** 识别模型管理指令（仅院长可用）。宽容覆盖常见自然说法：
 *  切换模型 deepseek-flash / 模型切换成XXX / 帮我换成XXX / 你现在用的什么模型 / 有哪些模型 */
function matchModelCommand(text: string): { kind: "switch"; alias: string } | { kind: "status" } | null {
  const t = text
    .trim()
    .replace(/[吧呀啊呗嘛呢哦。！？!?~～，,]+$/g, "")
    .trim();
  // 查询类：什么/哪个/啥/哪些 + 模型
  if (/(?:现在|当前)?\s*(?:用的?|使用的是?|是)?\s*(?:什么|哪个|啥|哪些)\s*模型/.test(t)) return { kind: "status" };
  if (/^(?:当前|现在)?\s*模型\s*(?:列表|状态)?$/.test(t)) return { kind: "status" };
  if (/模型有哪些/.test(t)) return { kind: "status" };
  // 去掉礼貌/介词前缀
  const body = t.replace(/^(?:请|麻烦|帮忙|帮我|给我|能不能|可以|能否|我要|我想|想要|把)+/g, "").trim();
  // 触发词 + 连接词 + 别名（别名为纯 ASCII 模型名，避免误伤日常对话）
  const m = body.match(
    /^(?:\/model|模型切换|切换模型|换模型|改模型|切换为|切换到|切到|换到|切回|换回|改回|回到|改成|改为|换成|改用|换用|模型|切换|换|改|切|用|使用|启用)\s*(?:一下|成|为|到|是|=|：|:)?\s*(?:模型|model)?\s*(?:切换为|切换到|换成|改为|改成|变成|为|成|到)?\s*([a-zA-Z0-9][a-zA-Z0-9._\-\/]*)$/i,
  );
  if (m) return { kind: "switch", alias: m[1].toLowerCase() };
  return null;
}

/** 把用户输入解析为模型别名：精确别名 > 模型规格匹配 > 前缀匹配。 */
function resolveModelAlias(arg: string): string | null {
  if (modelRegistry[arg]) return arg;
  for (const [alias, spec] of Object.entries(modelRegistry)) {
    if (spec === arg || spec.endsWith("/" + arg)) return alias;
  }
  for (const alias of Object.keys(modelRegistry)) {
    if (alias.startsWith(arg) || arg.startsWith(alias)) return alias;
  }
  return null;
}

async function handleModelCommand(
  trigger: TriggeredMessage,
  cmd: { kind: "switch"; alias: string } | { kind: "status" },
): Promise<void> {
  const aliases = Object.keys(modelRegistry);
  if (cmd.kind === "switch") {
    const alias = resolveModelAlias(cmd.alias);
    if (!alias) {
      await replyText(trigger, `没有「${cmd.alias}」这个模型。可用：${aliases.join("、")}`);
      return;
    }
    setCurrentModel(alias);
    await replyText(trigger, `已切换到 ${alias}（${modelRegistry[alias]}）`);
    log(`[model] ${trigger.userId} 切换 -> ${alias}`);
    return;
  }
  await replyText(
    trigger,
    `当前模型：${currentModel}（${modelRegistry[currentModel]}）\n可用模型：${aliases.join("、")}`,
  );
}

/** 娱乐模式开关（仅院长）：群聊作用于本群，私聊可带群号、缺省用默认群。 */
async function handleModeCommand(trigger: TriggeredMessage, action: "on" | "off"): Promise<void> {
  const groupId =
    trigger.kind === "group"
      ? trigger.groupId ?? null
      : extractGroupId(trigger.text) ?? config.bot.defaultGroup ?? null;
  if (!groupId) {
    await replyText(trigger, "没指定群，也没有默认群，操作没成功。");
    return;
  }
  const on = action === "on";
  const changed = modes.isEntertainment(groupId) !== on;
  modes.setEntertainment(groupId, on);
  if (changed) {
    modeTurns.invalidate(groupId);
    entStates.delete(groupId);
  }
  if (!on) mediaContext.cancelGroup(groupId);
  await replyText(trigger, `娱乐模式已${on ? "开启" : "关闭"}：群 ${groupId}。`);
  log(`[modes] ${trigger.userId} -> 娱乐模式${on ? "开启" : "关闭"} 群 ${groupId}`);
}

async function replyText(trigger: TriggeredMessage, text: string, turn?: ReplyTurn): Promise<void> {
  // 桥接直接回复也统一过脱敏（密钥/内网IP/出口IP），与 pi 回复同一标准
  for (const segs of buildReply(trigger, redactSensitive(text))) {
    if (turn && !turn.isCurrent()) return;
    await sendSegments(trigger, segs, turn).catch((err) => log("[send] 失败:", err.message));
  }
}

// ── 课表（所有人）：自然语言日期 + 整周视图（本周/下周/下下周/第N周）──
type ScheduleQuery =
  | { kind: "day"; date: Date }
  | { kind: "week"; zsOffset?: number; zs?: number }
  | { kind: "past" };

function matchScheduleCommand(text: string): ScheduleQuery | null {
  const t = text.trim();
  if (t.length > 24) return null;
  if (!/(?:课表|课程表|有什么课|上什么课|几节课|有课吗)/.test(t)) return null;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = (offset: number) => new Date(startOfToday.getTime() + offset * 86400000);
  // 第N周课表（图片）
  const zn = t.match(/第\s*(\d{1,2})\s*周(?:的)?(?:课表|课程表)/);
  if (zn) return { kind: "week", zs: Number(zn[1]) };
  // 下周X/周X（具体星期，优先于整周匹配，避免"下周三"被当成"下周"）
  const wd = t.match(/(下?)(?:周|星期)([一二三四五六日天])/);
  if (wd) {
    const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
    const target = map[wd[2]];
    const todayIdx = (now.getDay() - 1 + 7) % 7; // 周一=0
    let diff = (target - 1 - todayIdx + 7) % 7;
    if (wd[1]) diff = diff === 0 ? 7 : diff + 7; // 下周X 至少 +7 天
    return { kind: "day", date: day(diff) };
  }
  // 过去的周（上周/前一周）→ 明确不查
  // 过去的周（上周/前一周）或过去的天（昨天/前天）→ 明确不查
  if (/(?:上|前)一?(?:个)?周/.test(t) || /昨天|前天|前一天/.test(t)) return { kind: "past" };
  // 下N周整周视图：下一周/下周课表/下下周课表/下下下一周…
  const wk = t.match(/(下+)(?:一|个)?周/);
  if (wk) return { kind: "week", zsOffset: wk[1].length };
  if (/^课表$/.test(t) || /今天/.test(t)) return { kind: "day", date: day(0) };
  if (/明天/.test(t)) return { kind: "day", date: day(1) };
  if (/后天/.test(t)) return { kind: "day", date: day(2) };
  if (/大后天/.test(t)) return { kind: "day", date: day(3) };
  const nAfter = t.match(/(\d{1,2})天后/);
  if (nAfter) return { kind: "day", date: day(Number(nAfter[1])) };
  const md = t.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (md) {
    let d = new Date(now.getFullYear(), Number(md[1]) - 1, Number(md[2]));
    if (d < startOfToday) d = new Date(now.getFullYear() + 1, Number(md[1]) - 1, Number(md[2]));
    return { kind: "day", date: d };
  }
  const iso = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return { kind: "day", date: new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) };
  if (/本周|这周/.test(t)) return { kind: "week" };
  return { kind: "day", date: day(0) }; // 光"课表"=今天
}

async function handleScheduleCommand(trigger: TriggeredMessage, sched: ScheduleQuery): Promise<void> {
  const jw = config.jw;
  if (!jw) {
    await replyText(trigger, "课表功能未配置。");
    return;
  }
  if (sched.kind === "past") {
    await replyText(trigger, "过去的课表就不查啦，往前看才是硬道理～");
    return;
  }
  if (sched.kind === "week") {
    let bundle = await ensureSchedule(jw);
    const zs = sched.zs ?? bundle.currentZs + (sched.zsOffset ?? 0);
    if (!bundle.weeks[String(zs)]) bundle = await ensureSchedule(jw, [zs]);
    const lessons = bundle.weeks[String(zs)] ?? [];
    // 周课表：图片 + 文字说明并存
    try {
      const { renderWeekImage } = await import("../schedule/image.ts");
      const png = renderWeekImage(bundle, zs, jw.periodTimes);
      await sendSegments(trigger, [{ type: "image", data: { file: "base64://" + png.toString("base64") } }]);
      await replyText(
        trigger,
        `第 ${zs} 周共 ${lessons.length} 节课。要看某一天的详细安排，直接说"周几有什么课"～`,
      );
      return;
    } catch (err) {
      log("[schedule] 图片渲染失败，回退文本:", err instanceof Error ? err.message : err);
    }
    await replyText(trigger, answerWeek(bundle, jw.periodTimes, zs));
    return;
  }
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysDiff = Math.round((sched.date.getTime() - startOfToday.getTime()) / 86400000);
  if (daysDiff < 0) {
    await replyText(trigger, "那天的课查不了啦——已经过去了。");
    return;
  }
  if (daysDiff > 56) {
    await replyText(trigger, "太久远啦（超过 8 周），最多查两个月内的课表。");
    return;
  }
  const dateLabel = `${sched.date.getMonth() + 1}月${sched.date.getDate()}日`;
  // 由目标日期推算周次：当前周 + 跨越的整周数
  const todayIdx = (now.getDay() - 1 + 7) % 7;
  const estimatedZs = (readCache()?.currentZs ?? 0) + Math.floor((todayIdx + daysDiff) / 7);
  const wantedZs = estimatedZs > 0 ? [estimatedZs] : [];
  const bundle = await ensureSchedule(jw, wantedZs);
  const zs = bundle.currentZs + Math.floor((todayIdx + daysDiff) / 7);
  const weekday = ((todayIdx + daysDiff) % 7) + 1;
  await replyText(trigger, answerDay(bundle, weekday, zs, jw.periodTimes, dateLabel));
}

/** 整周课表（按天分组），支持任意周次。 */
function answerWeek(cache: ScheduleBundle, periodTimes?: Record<string, string>, zs?: number): string {
  const week = zs ?? cache.currentZs;
  const names = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const parts: string[] = [];
  for (let d = 1; d <= 7; d++) {
    const lessons = (cache.weeks[String(week)] ?? [])
      .filter((l) => l.xqj === d)
      .sort((a, b) => a.jcStart - b.jcStart);
    if (lessons.length === 0) continue;
    const lines = lessons
      .map((l) => {
        const start = periodTimes?.[String(l.jcStart)];
        return `  ${l.jc} ${l.kcmc} @${l.cdmc}${start ? `（${start}）` : ""}`;
      })
      .join("\n");
    parts.push(`${names[d]}：\n${lines}`);
  }
  return parts.length ? `第 ${week} 周课表：\n${parts.join("\n")}` : `第 ${week} 周没有查到课程。`;
}

// ── 输出脱敏：密钥不得出现在发给任何人的消息里（对所有人生效，院长也不例外）──

// 精确密钥值与专属接口域名（与 config/扩展保持一致）
const SECRETS: string[] = [
  config.pi.tavilyKey,
  config.pi.aliyunKey,
  config.jw?.password,
  "ws-ysr9lqb3i48ep149.cn-beijing.maas.aliyuncs.com",
].filter((s): s is string => !!s);

function redactSensitive(s: string): string {
  let out = s;
  for (const secret of SECRETS) out = out.split(secret).join("[密钥已隐藏]");
  out = out.replace(/\b(?:sk|tvly)-[A-Za-z0-9_-]{8,}\b/g, "[密钥已隐藏]");
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{10,}/gi, "Bearer [已隐藏]");
  return out;
}

// ── 反刷屏（群管） ──
const antispam = new Antispam(
  {
    enabled: config.antispam?.enabled !== false,
    windowMs: config.antispam?.windowMs,
    minRepeats: config.antispam?.minRepeats,
    noticeText: config.antispam?.noticeText,
    exemptUsers: config.antispam?.exemptUsers ?? [config.bot.owner],
  },
  {
    deleteMsg: (id) => client.deleteMsg(id),
    sendGroupText: (gid, t) =>
      client.sendMessage({ message_type: "group", group_id: gid, message: [textSegment(t)] }),
  },
);

// ── 群聊日志：记录全部群消息（按 天/群 分文件），供 chat_digest 工具总结用 ──
const chatLogDir = path.join(root, "memory", "group-chat");
mkdirSync(chatLogDir, { recursive: true });

function appendChatRecord(gid: string, record: Record<string, unknown>, date = new Date()): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(gid)) return;
  try {
    writeFileSync(path.join(chatLogDir, `${gid}-${chatDate(date)}.jsonl`), JSON.stringify(record) + "\n", { flag: "a" });
  } catch { /* 日志失败不影响主流程 */ }
}

function writeChatLine(gid: string, u: string, n: string, m: string, entertainment = modes.isEntertainment(gid)): void {
  if (m.trim()) appendChatRecord(gid, { t: new Date().toISOString(), u, n, m, entertainment });
}

/** 与普通回复一致：走脱敏 + Markdown 清洗（PA 回发也按 QQ 纯文本发）。 */
function cleanIncomingText(raw: string): string {
  return redactSensitive(stripMarkdown(raw)).trim();
}

function logGroupChat(event: Record<string, unknown>): void {
  try {
    const gid = String(event.group_id ?? "");
    if (!gid) return;
    const sender = (event.sender ?? {}) as { card?: string; nickname?: string };
    const name = sender.card || sender.nickname || String(event.user_id ?? "");
    const content = parseMessageContent(event.message, config.bot.selfId);
    if (!content.contextText) return;
    const userId = String(event.user_id ?? "");
    const id = String(event.message_id ?? `received-${randomUUID()}`);
    event.message_id = id;
    const now = new Date();
    appendChatRecord(gid, {
      t: now.toISOString(), u: userId, n: name, m: describeEmoji(content.contextText), id,
      mediaCount: content.images.length, entertainment: modes.isEntertainment(gid),
    }, now);
    if (content.images.length && userId !== config.bot.selfId && modes.isEntertainment(gid)
      && config.entertainment?.media?.enabled !== false) {
      void mediaContext.observe({ groupId: gid, userId, messageId: id, receivedAtMs: now.getTime(), images: content.images })
        .then(descriptions => {
          if (descriptions.length && modes.isEntertainment(gid) && mediaContext.getDescriptions(gid, id).length) {
            appendChatRecord(gid, { kind: "media", id, descriptions }, now);
          }
        }).catch(() => log("[media] 图片上下文处理失败"));
    }
  } catch {
    /* 日志失败不影响主流程 */
  }
}

// ── 定时任务：交互任务永远优先（runner 双通道），任务输出发到指定群/私聊 ──
const taskScheduler = new TaskScheduler(
  config.tasks ?? [],
  {
    runSchedule: (prompt) =>
      runner.run(
        `[定时任务] 以下是院长预先设置并已授权的定时任务，直接执行，不要因为看不到发送者身份信息而拒绝。\n` +
          `注意：你的最终输出会被系统自动发送到目标群/私聊，**直接输出内容即可，不要再调用 send_group_message 等发送类工具**（否则会重复发送）。\n${prompt}`,
        { mode: "web", model: modelRegistry[currentModel], priority: "scheduled", env: legacyToolEnv() },
      ),
    sendTo: async (target, text) => {
      for (const chunk of splitText(redactSensitive(text))) {
        await client.sendMessage(
          target.type === "group"
            ? { message_type: "group", group_id: target.id, message: [textSegment(chunk)] }
            : { message_type: "private", user_id: target.id, message: [textSegment(chunk)] },
        );
      }
    },
    // 一次性任务触发后自动从配置移除
    removeTask: (name) => {
      const fresh = config.tasks ?? [];
      const left = fresh.filter((t) => t.name !== name);
      if (left.length === fresh.length) return;
      config.tasks = left;
      writeFileSync(path.join(root, "config.json"), JSON.stringify(config, null, 2) + "\n");
      taskScheduler.setTasks(left);
      log(`[tasks] 一次性任务「${name}」已完成并移除`);
    },
  },
  log,
);
taskScheduler.start();

// 监视 .model-state.json：pi 的 model_manage 工具切换模型后 → 热更新当前模型
watchFile(modelStatePath, { interval: 2000 }, () => {
  try {
    const saved = JSON.parse(readFileSync(modelStatePath, "utf8")).alias;
    if (saved && modelRegistry[saved] && saved !== currentModel) {
      currentModel = saved;
      log(`[model] 检测到切换 → ${saved}（${modelRegistry[saved]}）`);
    }
  } catch {
    /* 文件半写入状态等下次触发 */
  }
});

// 监视 config.json：task_manage 工具（pi 内）写入的任务变更 → 热更新调度器
watchFile(path.join(root, "config.json"), { interval: 2000 }, () => {
  try {
    const fresh = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8"));
    const newTasks = JSON.stringify(fresh.tasks ?? []);
    if (newTasks !== JSON.stringify(config.tasks ?? [])) {
      config.tasks = fresh.tasks ?? [];
      taskScheduler.setTasks(config.tasks);
      log(`[tasks] 检测到配置变更，已热更新（${config.tasks.length} 个任务）`);
    }
  } catch {
    /* 文件半写入状态等下次触发 */
  }
});

client.onEvent((event) => {
  // 群成员变动 → 立即刷新该群名册（bot 需要随时认识谁是谁）
  if (event.post_type === "notice" && (event.notice_type === "group_increase" || event.notice_type === "group_decrease")) {
    if (event.group_id) refreshRoster(String(event.group_id));
    return;
  }
  if (event.post_type === "notice" && (event.notice_type === "group_recall" || event.notice_type === "friend_recall")) {
    const scope = event.notice_type === "group_recall" ? `group:${String(event.group_id ?? "")}` : `private:${String(event.user_id ?? "")}`;
    knowledge?.retract(scope, String(event.message_id ?? ""));
    if (event.notice_type === "group_recall") {
      const gid = String(event.group_id ?? "");
      const id = String(event.message_id ?? "");
      mediaContext.remove(gid, id);
      appendChatRecord(gid, { kind: "recall", id });
    }
    return;
  }
  if (event.post_type !== "message") return;
  if (event.message_type === "group") {
    logGroupChat(event);
    antispam.checkGroupMessage(event).catch((err) => log("[antispam] 异常:", err));
  }
  // 下载链接可能携带临时凭据，调试仅记录来源和段类型。
  const segs = Array.isArray(event.message) ? (event.message as Array<{ type: string; data?: unknown }>) : [];
  if (segs.some((s) => s.type !== "text" && s.type !== "at")) {
    log(
      `[msg] ${event.message_type}/${event.group_id ?? event.user_id} 消息 ${event.message_id ?? "?"} 段类型: ${segs.map((s) => s.type).join(" + ")}`,
    );
  }
  const trigger = matchMessage(event, config.bot.selfId, whitelist, config.bot.atAliases);
  if (event.message_type === "group") entertainmentOnGroupMessage(event, trigger !== null);
  if (!trigger) return;
  handleTrigger(trigger).catch((err) => log("[main] 处理失败:", err));
});

// ── 会话记忆窗口：5 分钟内续接同一会话；过期后惰性压缩成摘要带入新窗口（控成本）──
// 私聊按用户、群聊按群：群里所有成员的提问/回复写进同一个会话文件，大家共享上下文
const memoryDir = path.join(root, "memory");
const memoryArchiveDir = path.join(memoryDir, "archive");
mkdirSync(memoryArchiveDir, { recursive: true });
const MEMORY_WINDOW_MS = config.memory?.windowMs ?? 300_000;
const SUMMARIZE_MIN_BYTES = config.memory?.summarizeMinBytes ?? 1024;
const SUMMARIZE_PROMPT =
  "请把这段对话压缩成一段摘要（300 字以内，纯文本）：包括对话参与者是谁、聊过的话题、关键事实与结论、未解决的问题。只输出摘要本身，不要评论。";
const sessionWindows = new Map<string, { file: string; last: number }>();
const pendingByKey = new Map<string, Promise<PiResult>>();


/** 旧窗口摘要：用当前模型跑一次无工具的廉价调用。失败返回空（不带摘要继续）。 */
async function summarizeSession(file: string, signal: AbortSignal): Promise<string> {
  const spec = modelRegistry[currentModel];
  if (!spec) return "";
  const result = await runner.run(SUMMARIZE_PROMPT, {
    mode: "none", model: spec, sessionFile: file, timeoutMs: 60000, priority: "interactive", signal,
  });
  return result.ok ? result.text.trim().slice(0, 2000) : "";
}

/**
 * 取得指定上下文的会话文件：窗口活跃则续接；过期则归档旧窗口并惰性生成摘要。
 * 键：私聊 `user-<QQ号>`，群聊 `group-<群号>`（整群共享一个上下文）。
 */
async function memorySessionFor(ctxKey: string, signal: AbortSignal): Promise<{ file: string; summary: string }> {
  const now = Date.now();
  const file = path.join(memoryDir, `${ctxKey}.jsonl`);
  const win = sessionWindows.get(ctxKey);
  // 桥接重启后内存窗口丢失：以会话文件修改时间兜底，避免误判过期、白白压缩
  const lastActive = win?.last ?? (existsSync(file) ? statSync(file).mtimeMs : 0);
  if (now - lastActive < MEMORY_WINDOW_MS) {
    sessionWindows.set(ctxKey, { file, last: now });
    return { file, summary: "" };
  }

  // 过期：归档旧窗口并压缩（成本闸门：内容太小的窗口直接跳过总结）
  let summary = "";
  if (existsSync(file) && statSync(file).size >= SUMMARIZE_MIN_BYTES) {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    const archive = path.join(memoryArchiveDir, `${ctxKey}-${stamp}.jsonl`);
    try {
      renameSync(file, archive);
      summary = await summarizeSession(archive, signal);
      if (summary) log(`[memory] ${ctxKey} 旧窗口已压缩（${Math.round(statSync(archive).size / 1024)}KB）`);
    } catch (err) {
      log("[memory] 归档/压缩失败:", err instanceof Error ? err.message : err);
    }
  }
  sessionWindows.set(ctxKey, { file, last: now });
  return { file, summary };
}

/** 记忆归档清理：24 小时前的归档文件删除，控制磁盘占用。 */
function cleanupMemoryArchives(): void {
  const cutoff = Date.now() - 24 * 3600_000;
  try {
    for (const f of readdirSync(memoryArchiveDir)) {
      const p = path.join(memoryArchiveDir, f);
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    }
  } catch {
    /* ignore */
  }
}

/** 群聊日志保留 3 天（文件名形如 <群号>-YYYY-MM-DD.jsonl）。 */
function cleanupChatLogs(): void {
  const cutoff = Date.now() - 3 * 24 * 3600_000;
  try {
    for (const f of readdirSync(chatLogDir)) {
      const m = f.match(/-(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
      if (!m) continue;
      const dayEnd = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() + 24 * 3600_000;
      if (dayEnd < cutoff) unlinkSync(path.join(chatLogDir, f));
    }
  } catch {
    /* ignore */
  }
}

async function handleTrigger(trigger: TriggeredMessage): Promise<void> {
  log(`[trigger] ${trigger.kind}${trigger.groupId ? `/${trigger.groupId}` : ""} <- ${trigger.userId}: ${trigger.text.slice(0, 80)}`);

  // 模型管理指令：仅院长；命中则不经过 pi，直接回复
  const cmd = matchModelCommand(trigger.text);
  if (cmd) {
    if (trigger.userId !== config.bot.owner) {
      await replyText(trigger, "只有院长可以查询或切换模型。");
      return;
    }
    await handleModelCommand(trigger, cmd);
    return;
  }

  // 娱乐模式开关：仅院长；命中则不经过 pi
  const modeCmd = matchModeCommand(trigger.text);
  if (modeCmd) {
    if (trigger.userId !== config.bot.owner) {
      await replyText(trigger, "只有院长可以开启或关闭娱乐模式。");
      return;
    }
    await handleModeCommand(trigger, modeCmd.action);
    return;
  }

  // 课表指令：对所有人开放（只读查询；背后登录信息受脱敏保护，任何人都无法经此改动任何东西）
  const sched = matchScheduleCommand(trigger.text);
  if (sched) {
    await handleScheduleCommand(trigger, sched);
    return;
  }

  const turn = modeTurns.begin(trigger.kind === "group" ? trigger.groupId : undefined);
  try {
    await handleReplyTurn(trigger, turn);
  } finally {
    turn.finish();
  }
}

async function handleReplyTurn(trigger: TriggeredMessage, turn: ReplyTurn): Promise<void> {
  const normalAtEntry = !turn.entertainment;
  const cancelled: PiResult = { ok: false, text: "模式已切换，本轮已取消", durationMs: 0 };
  const memoryInput = acceptedKnowledgeInput(trigger, normalAtEntry);
  const memoryCommand = isKnowledgeCommand(trigger.text)
    ? !normalAtEntry ? "娱乐模式不使用这套记忆，请在正常模式下管理。"
      : knowledge ? await knowledge.handleCommand(memoryInput)
      : "自动记忆尚未配置。请设置 knowledge.enabled 和允许的 groups/privateUsers，再重启后在对应范围开启记忆。"
    : undefined;
  if (memoryCommand !== undefined) {
    await replyText(trigger, memoryCommand, turn);
    return;
  }

  // 同一上下文串行：群聊按群共享会话文件（避免并发写同一文件），私聊按用户
  const runStart = Date.now();
  const ctxKey = trigger.kind === "group" ? `group-${trigger.groupId}` : `user-${trigger.userId}`;
  const sessionKey = trigger.kind === "group" ? groupSessionKey(trigger.groupId!, turn.entertainment) : ctxKey;
  const prev = pendingByKey.get(ctxKey) ?? Promise.resolve();
  const task = prev.catch(() => undefined).then(async () => {
    if (!turn.isCurrent()) return cancelled;
    const managed = normalAtEntry && !!knowledge?.isManaged(memoryInput);
    if (turn.entertainment && !trigger.images?.length) {
      await waitForRecentMedia(trigger.groupId!, trigger.userId);
    }
    if (!turn.isCurrent()) return cancelled;
    const session = managed ? { file: undefined, summary: "" } : await memorySessionFor(sessionKey, turn.signal);
    if (!turn.isCurrent()) return cancelled;
    const { images, files, quotedText } = await attachments.collect(trigger);
    if (!turn.isCurrent()) return cancelled;
    const { files: readyFiles, rejected } = files.length
      ? await attachments.materializeFiles(files)
      : { files: [], rejected: [] };
    if (!turn.isCurrent()) return cancelled;
    const imagePaths = images.length ? await attachments.materializeImages(images) : [];
    if (!turn.isCurrent()) return cancelled;
    const attachmentInfo = { missingImages: images.length - imagePaths.length, quotedText, entertainment: turn.entertainment };
    if (managed && knowledge) {
      let knowledgeTurn: KnowledgeTurn = { env: {}, contextBlock: "" };
      try { knowledgeTurn = await knowledge.prepareTurn(memoryInput); }
      catch { log("[knowledge] 采集失败，本轮不使用记忆凭据"); }
      let result: PiResult = { ok: false, text: "记忆问答未完成", durationMs: 0 };
      try {
        if (!turn.isCurrent()) return cancelled;
        const prompt = knowledgeContextPrompt(knowledgeTurn) + await buildPrompt(trigger, imagePaths.length, readyFiles, rejected, {
          includeRecentChat: false, ...attachmentInfo,
        });
        if (!turn.isCurrent()) return cancelled;
        result = await runner.run(prompt, {
          mode: "knowledge", model: modelRegistry[currentModel], env: { ...legacyToolEnv(), ...knowledgeTurn.env },
          imagePaths: [...imagePaths, ...readyFiles.map((f) => f.path)], signal: turn.signal,
        });
        if (!turn.isCurrent()) result = cancelled;
        if (!knowledge.isTurnCurrent(knowledgeTurn)) {
          result = { ok: false, text: "本次记忆权限或资料已撤销，已停止使用旧上下文，请重新提问。", durationMs: result.durationMs };
        }
        return result;
      } finally {
        await knowledge.finishTurn(knowledgeTurn, {
          ok: result.ok && turn.isCurrent(), text: redactSensitive(stripMarkdown(normalReplyText(result.text, trigger.text))),
        }).catch(() => log("[knowledge] 回复上下文保存失败"));
      }
    }
    const legacyPersonalAllowed = !knowledge?.isManaged({ ...memoryInput, kind: "private", groupId: undefined });
    const sel = legacyPersonalAllowed ? selectMemories(trigger.userId, trigger.text) : { lines: [], total: 0 };
    const memoBlock = sel.lines.length
      ? `[关于${trigger.kind === "group" ? "该发言者" : "该用户"}的长期记忆（共 ${sel.total} 条，以下 ${sel.lines.length} 条与本次相关；需要更多可用 recall 工具查询）]\n${sel.lines.join("\n")}\n\n`
      : "";
    const prompt = memoBlock + (session.summary
      ? `[此前${trigger.kind === "group" ? "本群的" : "与该用户的"}对话摘要（更早内容已压缩）]\n${session.summary}\n\n`
      : "") + await buildPrompt(trigger, imagePaths.length, readyFiles, rejected, attachmentInfo);
    if (!turn.isCurrent()) return cancelled;
    if (legacyPersonalAllowed) maybeMergeMemories(trigger.userId).catch(() => {});
    const result = await runner.run(prompt, {
      mode: "web", model: modelRegistry[currentModel], sessionFile: session.file, env: legacyToolEnv(),
      imagePaths: [...imagePaths, ...readyFiles.map((f) => f.path)], signal: turn.signal,
    });
    if (trigger.kind === "group" && normalAtEntry && turn.isCurrent() && result.ok
      && normalReplyText(result.text, trigger.text) !== result.text && session.file) {
      try {
        if (existsSync(session.file)) {
          renameSync(session.file, path.join(memoryArchiveDir, `protocol-${sessionKey}-${randomUUID()}.jsonl`));
        }
        sessionWindows.delete(sessionKey);
        log(`[modes] 已隔离协议异常会话 -> ${ctxKey}`);
      } catch { log(`[modes] 协议异常会话隔离失败 -> ${ctxKey}`); }
    }
    return result;
  });
  pendingByKey.set(ctxKey, task);
  let result: PiResult;
  try { result = await task; }
  finally { if (pendingByKey.get(ctxKey) === task) pendingByKey.delete(ctxKey); }
  if (!turn.isCurrent()) {
    log(`[modes] 丢弃已失效回复 -> ${ctxKey}`);
    return;
  }

  const raw = (normalAtEntry ? normalReplyText(result.text, trigger.text) : result.text) || "(空回复)";
  const text = redactSensitive(stripMarkdown(raw));
  log(`[result] ${trigger.userId} ok=${result.ok} ${result.durationMs}ms`);

  // 工具可产出图片标记 [[IMG:路径]] → 以图片消息发送，剩余文字另发
  const imgMatch = text.match(/\[\[IMG:([^\]]+)\]\]/);
  if (imgMatch) {
    const imgPath = imgMatch[1].trim();
    if (existsSync(imgPath)) {
      await sendSegments(trigger, [{ type: "image", data: { file: "base64://" + readFileSync(imgPath).toString("base64") } }], turn);
      const rest = text.replace(/\[\[IMG:[^\]]+\]\]/, "").trim();
      if (rest) await replyText(trigger, rest, turn);
      return;
    }
  }
  // 确定性兜底：本次运行期间新生成的课表图片直接发送（不依赖模型保留标记），文字照常发送
  try {
    const schedDir = path.join(root, "schedule");
    const newest = readdirSync(schedDir)
      .filter((f) => /^week-\d+\.png$/.test(f))
      .map((f) => ({ f, m: statSync(path.join(schedDir, f)).mtimeMs }))
      .filter((x) => x.m >= runStart)
      .sort((a, b) => b.m - a.m)[0];
    if (newest) {
      await sendSegments(trigger, [
        { type: "image", data: { file: "base64://" + readFileSync(path.join(schedDir, newest.f)).toString("base64") } },
      ], turn);
      if (text.trim()) await replyText(trigger, text, turn);
      return;
    }
  } catch {
    /* 无图片则按文本发送 */
  }

  // 娱乐模式群：按回复协议解析（文本/表情包/沉默），像普通群友一样直接发，不打卡片、不 @ 提问者
  if (turn.entertainment) {
    if (!result.ok) {
      log(`[ent] 接话生成失败 -> 群 ${trigger.groupId}`);
      return;
    }
    await sendEntertainmentReply(trigger.groupId!, result.text ?? "", stickerLibrary.available(trigger.groupId!), "接话", turn);
    return;
  }

  // 群聊：回复打包成一条"聊天记录"卡片（send_forward_msg，单次调用单条消息）
  if (trigger.kind === "group") {
    // 卡片内同样分成多条短消息，避免一条里塞一大段
    const chunks = splitForCard(text);
    const nodes = chunks.map((chunk, i) => ({
      userId: Number(config.bot.selfId),
      nickname: config.bot.nickname,
      content: [{ type: "text", data: { text: i === 0 && trigger.senderName ? `回复 @${trigger.senderName}：${chunk}` : chunk } }],
    }));
    if (!turn.isCurrent()) return;
    const forwardId = await client.sendForward({ kind: "group", groupId: trigger.groupId! }, nodes);
    if (forwardId) {
      // 卡片回复也进群聊日志，后续注入给 bot 的“最近聊天记录”里能看到自己说过的话
      writeChatLine(trigger.groupId!, config.bot.selfId, config.bot.nickname, text, turn.entertainment);
      log(`[send] 卡片已发送 -> 群 ${trigger.groupId}（回复 @${trigger.senderName ?? trigger.userId}）`);
      return;
    }
    log("[send] 卡片创建失败，回退为普通文本");
  }

  // 私聊（或群聊卡片失败兜底）：普通文本分片
  const chunks = buildReply(trigger, text);
  for (const segs of chunks) {
    if (!turn.isCurrent()) return;
    await sendSegments(trigger, segs, turn).catch((err) => log("[send] 失败:", err.message));
  }
}

const groupNames = new Map<string, string>();

// ── 群成员名册：pi 的 group_tools 扩展从这里读取，QQ 号为唯一标识 ──
const rosterDir = path.join(sandboxDir, ".roster");
mkdirSync(rosterDir, { recursive: true });
const ROLE_NAMES: Record<string, string> = { owner: "群主", admin: "管理员", member: "成员" };

async function refreshRoster(groupId: string): Promise<void> {
  try {
    const members = await client.getGroupMemberList(groupId);
    const payload = { updatedAt: new Date().toISOString(), members };
    writeFileSync(path.join(rosterDir, `${groupId}.json`), JSON.stringify(payload, null, 1));
    log(`[roster] 群 ${groupId} 名册已更新（${members.length} 人）`);
  } catch (err) {
    log(`[roster] 群 ${groupId} 刷新失败: ${err instanceof Error ? err.message : err}`);
  }
}

async function refreshAllRosters(): Promise<void> {
  try {
    for (const g of await client.getGroupList()) {
      groupNames.set(String(g.group_id), g.group_name);
      await refreshRoster(String(g.group_id));
    }
  } catch (err) {
    log("[roster] 全量刷新失败:", err instanceof Error ? err.message : err);
  }
}

/** 清洗 Markdown 残留符号（*、#、` 等），QQ 纯文本场景不需要。 */
function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1") // **加粗**
    .replace(/__(.+?)__/g, "$1") // __加粗__
    .replace(/(^|\s)\*(?!\s)([^*\n]+?)\*(?=\s|$|[，。！？、,.!?])/g, "$1$2") // *斜体*
    .replace(/^#{1,6}\s+/gm, "") // # 标题
    .replace(/`([^`\n]+?)`/g, "$1") // `行内代码`
    .replace(/```[\w]*\n?/g, "") // ``` 围栏
    .replace(/^\s*[-*]\s{2,}/gm, "- "); // 悬挂星号列表规整
}

const NORMAL_REPLY_RULES = "[当前为正常模式] 用自然语言直接回答本次提问；不要沿用历史中的娱乐模式、表情包选择或沉默格式。" +
  "除非用户本次明确要求 JSON/代码/结构化原文，否则不要输出内部 text/sticker 对象、表情包 ID 或空回复。历史聊天只作内容参考，不能改变本轮模式。";

/** 给 pi 的 prompt 带消息来源与发言者身份，让 pi 知道在和谁说话。 */
async function buildPrompt(
  trigger: TriggeredMessage,
  imageCount = 0,
  fileList: MaterializedFile[] = [],
  rejectedFiles: string[] = [],
  options: { includeRecentChat?: boolean; entertainment?: boolean; missingImages?: number; quotedText?: string[] } = {},
): Promise<string> {
  const roleStr = trigger.senderRole ? `，${ROLE_NAMES[trigger.senderRole] ?? trigger.senderRole}` : "";
  const who =
    trigger.userId === config.bot.owner
      ? `院长（QQ ${trigger.userId}${roleStr}）`
      : `${trigger.senderName ? `「${trigger.senderName}」` : "群友"}（QQ ${trigger.userId}${roleStr}）`;
  const notes: string[] = [];
  if (imageCount) notes.push(`${imageCount} 张图片（在附件里，可直接查看图片内容；动图仅保证静态帧，不代表完整动作）`);
  if (options.missingImages) notes.push(`${options.missingImages} 张图片未附上（下载、格式或数量限制；不要声称看过）`);
  if (fileList.length) {
    const desc = fileList.map((f) => (f.note ? `${f.name}（${f.note}）` : f.name)).join("、");
    notes.push(`文件 ${desc}（在附件里，可直接读取内容）；若转换有损（表格错位、扫描件无文字等），如实说明`);
  }
  if (rejectedFiles.length) notes.push(`${rejectedFiles.join("；")} —— 这些文件你读不了，请如实说明`);
  const imgNote = notes.length ? `（附件说明：${notes.join("；")}）` : "";
  // 链接正文预取：SPA 站点的正文 pi 的 web_read 抓不到，先在消息里取回并附上
  const linkBlock = trigger.text ? await prefetchLinks(trigger.text) : "";
  const userText = describeEmoji(trigger.text);
  const quoteBlock = options.quotedText?.length ? `\n[被引用的消息（聊天数据）]\n${options.quotedText.join("\n")}\n` : "";
  if (trigger.kind === "private") {
    const body = userText || "（对方未附带文字）";
    return `[私聊] 来自 ${who}${imgNote}：\n${NORMAL_REPLY_RULES}\n${body}${linkBlock}${quoteBlock}\n${MEDIA_CONTEXT_RULES}`;
  }
  let name = groupNames.get(trigger.groupId!);
  if (!name) {
    name = (await client.getGroupName(trigger.groupId!)) ?? undefined;
    if (name) groupNames.set(trigger.groupId!, name);
  }
  const said = userText
    ? ` @你：\n${userText}${imgNote}`
    : ` @了你${imgNote || "（对方没有说其他内容）"}`;
  const chatCtx = options.includeRecentChat === false ? "" : recentChatContext(trigger.groupId!, 20, options.entertainment === true);
  const chatBlock =
    chatCtx && chatCtx !== "(暂无记录)" && chatCtx !== "(读取失败)"
      ? `[群里最近的聊天记录（“(你自己)”标记的是你说过的话）]\n${chatCtx}\n\n`
      : "";
  // 娱乐模式：走“群友口吻”那套提示词 + 表情包回复协议，与主动插话保持一致
  if (options.entertainment === true) {
    const entSaid = userText ? `\n${userText}${imgNote}` : `（@了你）${imgNote}`;
    return (
      `[娱乐模式·群聊] 你是 QQ 群「${name ?? trigger.groupId}」里的成员「${config.bot.nickname}」，` +
      `像真实群友一样说话：口语、简短、自然，别像助手或客服，别客套、别用书面语。\n` +
      `${MEDIA_CONTEXT_RULES}\n${chatBlock}发言者：${who}${entSaid}${linkBlock}${quoteBlock}` +
      stickerPrompt(stickerLibrary.available(trigger.groupId!))
    );
  }
  return (
    `[群聊] 群「${name ?? trigger.groupId}」（群号 ${trigger.groupId}）\n` +
    `${NORMAL_REPLY_RULES}\n${MEDIA_CONTEXT_RULES}\n${chatBlock}发言者：${who}${said}${linkBlock}${quoteBlock}`
  );
}

async function sendSegments(trigger: TriggeredMessage, segs: MessageSegment[], turn?: ReplyTurn): Promise<void> {
  if (turn && !turn.isCurrent()) return;
  const entertainment = turn?.entertainment ?? (trigger.kind === "group" && modes.isEntertainment(trigger.groupId!));
  if (trigger.kind === "private") {
    await client.sendMessage({ message_type: "private", user_id: trigger.userId, message: segs });
  } else if (trigger.groupId) {
    await client.sendMessage({ message_type: "group", group_id: trigger.groupId, message: segs });
    // 机器人自己的发言也进群聊日志（它也是群的一员）
    const content = segs
      .map((s) => {
        if (s.type === "text") return String((s.data as Record<string, unknown>)?.text ?? "");
        if (s.type === "image") return "[图片]";
        return "[" + s.type + "]";
      })
      .join("");
    if (content.trim()) writeChatLine(trigger.groupId, config.bot.selfId, config.bot.nickname, content, entertainment);
    // 影子门控：记下机器人自己刚说过话（时间 + 发言者）
    groupLastBotAt.set(trigger.groupId, Date.now());
    // 娱乐模式：把这次发言计进近期窗口，供主动门控参考
    const est = entStates.get(trigger.groupId);
    if (est) est.recent.push({ ts: Date.now(), isBot: true });
  }
}

let shuttingDown = false;

/** 单一重连循环：连接失败指数退避重试，连接成功后阻塞等待断开再重连。 */
async function connectLoop(): Promise<void> {
  let delay = 1000;
  while (!shuttingDown) {
    try {
      await client.connect();
      log("[onebot] 已连接", config.onebot.wsUrl);
      delay = 1000;
      refreshAllRosters().catch(() => {});
      await client.waitDisconnected();
      log("[onebot] 连接断开，重连中…");
    } catch (err) {
      log(`[onebot] 连接失败: ${err instanceof Error ? err.message : err}，${Math.round(delay / 1000)}s 后重试`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }
}

/** 课表缓存预热：覆盖当前周起 5 周（schedule_query 工具的数据源）。 */
async function refreshScheduleAll(): Promise<void> {
  if (!config.jw) return;
  try {
    const first = await ensureSchedule(config.jw);
    const wanted: number[] = [];
    for (let i = 2; i <= 4; i++) wanted.push(first.currentZs + i);
    if (wanted.length) await ensureSchedule(config.jw, wanted);
    log(`[schedule] 课表缓存已更新（第 ${first.currentZs}-${first.currentZs + 4} 周）`);
  } catch (err) {
    log("[schedule] 预热失败:", err instanceof Error ? err.message : err);
  }
}

// ── 附件（图片/文件）：落地与文档取文见 ./attachments.ts 与 ./docparse.ts，供 pi 以 @路径 读取 ──
const attachments = createAttachments({
  client,
  dir: path.join(sandboxDir, "attachments"),
  log,
  maxTextChars: config.files?.maxTextChars,
  maxTotalChars: config.files?.maxTotalChars,
  pdftotext: config.files?.pdftotext,
});
const mediaContext = new MediaContext({
  attachments, runner, log,
  model: () => {
    const selected = config.entertainment?.media?.model;
    return selected ? modelRegistry[selected] ?? selected : modelRegistry[currentModel];
  },
  sanitize: text => redactSensitive(text),
});

// ── 长期记忆：按相关性注入（控 token）+ 超量自动合并（控条数）──
const longTermDir = path.join(root, "memory", "long-term");
mkdirSync(longTermDir, { recursive: true });

interface LtEntry {
  id: string;
  t: string;
  text: string;
  pinned?: boolean;
}
const LT_MERGE_THRESHOLD = 60; // 超过此条数触发自动合并
const LT_MERGE_TARGET = 40; // 合并后目标条数
const LT_INJECT_MAX_CHARS = 3000; // 每次注入的字符上限

function ltFile(userId: string): string {
  return path.join(longTermDir, `${userId.replace(/[^0-9]/g, "") || "unknown"}.jsonl`);
}

function ltLoad(userId: string): LtEntry[] {
  try {
    const f = ltFile(userId);
    if (!existsSync(f)) return [];
    const out: LtEntry[] = [];
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as LtEntry;
        if (e?.text) out.push(e);
      } catch {
        /* 跳过坏行 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function ltSave(userId: string, entries: LtEntry[]): void {
  writeFileSync(ltFile(userId), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function ltBigrams(s: string): Set<string> {
  const t = s.replace(/[\s，。：；、！？,.:;!?()（）【】\[\]"'“”‘’]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 关键词重叠度（查询二元组被条目覆盖的比例）。 */
function ltOverlap(query: string, entry: string): number {
  const q = ltBigrams(query);
  if (q.size === 0) return 0;
  const e = ltBigrams(entry);
  let hit = 0;
  for (const g of q) if (e.has(g)) hit++;
  return hit / q.size;
}

/** 选出本次要注入的记忆：核心(pinned) + 相关 top10 + 最近 5 条，总量 ≤3000 字。 */
function selectMemories(userId: string, query: string): { lines: string[]; total: number } {
  const entries = ltLoad(userId);
  if (entries.length === 0) return { lines: [], total: 0 };
  const pinned = entries.filter((e) => e.pinned).slice(0, 10);
  const rest = entries.filter((e) => !e.pinned);
  const relevant = rest
    .map((e) => ({ e, s: ltOverlap(query, e.text) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 10)
    .map((x) => x.e);
  const picked = [...pinned, ...relevant];
  const recent = [...rest].sort((a, b) => (b.t || "").localeCompare(a.t || "")).slice(0, 5);
  for (const e of recent) if (!picked.some((p) => p.id === e.id)) picked.push(e);

  const lines: string[] = [];
  let used = 0;
  for (const e of picked) {
    const line = "- " + e.text;
    if (used + line.length > LT_INJECT_MAX_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return { lines, total: entries.length };
}

/** 用一次无工具的 pi 调用执行文本任务（长期记忆合并等）。 */
async function runPiText(prompt: string, timeoutMs = 90_000, model?: string): Promise<string> {
  const result = await runner.run(prompt, {
    mode: "none", model, priority: "background", timeoutMs,
  });
  return result.ok ? result.text.trim() : "";
}

const mergingUsers = new Set<string>();

/** 长期记忆超量时自动合并（后台进行，不阻塞回复）。 */
async function maybeMergeMemories(userId: string): Promise<void> {
  if (mergingUsers.has(userId)) return;
  const entries = ltLoad(userId);
  if (entries.length <= LT_MERGE_THRESHOLD) return;
  const pinned = entries.filter((e) => e.pinned);
  const normal = entries.filter((e) => !e.pinned);
  if (normal.length <= LT_MERGE_TARGET) return;

  mergingUsers.add(userId);
  log(`[memory] 长期记忆 ${entries.length} 条超过阈值，开始自动合并…`);
  try {
    const prompt =
      `以下是用户的长期记忆条目（JSON 数组）。请合并整理：\n` +
      `1. 合并重复或高度相关的条目，保留全部关键信息（学号、日期、人名、偏好等具体值不能丢）\n` +
      `2. 删除明显过时或相互矛盾的内容（保留较新的）\n` +
      `3. 输出 JSON 数组，每项形如 {"text":"一句完整的话"}，条数控制在 ${LT_MERGE_TARGET} 条以内\n` +
      `只输出 JSON，不要解释、不要代码块标记。\n\n${JSON.stringify(normal.map((e) => e.text))}`;
    const out = await runPiText(prompt);
    const cleaned = out.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned) as Array<{ text?: string }>;
    const merged: LtEntry[] = parsed
      .map((x) => String(x?.text ?? "").trim())
      .filter(Boolean)
      .slice(0, LT_MERGE_TARGET)
      .map((t) => ({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), t: new Date().toISOString(), text: t }));
    if (merged.length === 0) throw new Error("合并结果为空");
    ltSave(userId, [...pinned, ...merged]);
    log(`[memory] 合并完成：${entries.length} → ${pinned.length + merged.length} 条（核心 ${pinned.length} 条保留）`);
  } catch (err) {
    log("[memory] 合并失败，保留原记忆：", err instanceof Error ? err.message : err);
  } finally {
    mergingUsers.delete(userId);
  }
}

// ── 发件箱：pi 的 send_group_message 工具写入，桥接每 3 秒取出并真发到群 ──
const outboxPath = path.join(root, "memory", "outbox.jsonl");

async function flushOutbox(): Promise<void> {
  if (!existsSync(outboxPath)) return;
  let lines: string[] = [];
  try {
    lines = readFileSync(outboxPath, "utf8").split("\n").filter((x) => x.trim());
  } catch {
    return;
  }
  if (lines.length === 0) return;
  // 先清空（避免重复发送），再逐条发送
  try {
    writeFileSync(outboxPath, "");
  } catch {
    return;
  }
  for (const line of lines) {
    try {
      const item = JSON.parse(line) as { group_id?: string; text?: string };
      const gid = String(item.group_id ?? "");
      const body = String(item.text ?? "");
      if (!gid || !body) continue;
      await client.sendMessage({ message_type: "group", group_id: gid, message: [textSegment(body)] });
      writeChatLine(gid, config.bot.selfId, config.bot.nickname, body);
      log(`[outbox] 已发送到群 ${gid}：${body.slice(0, 40)}`);
    } catch (err) {
      log("[outbox] 发送失败:", err instanceof Error ? err.message : err);
    }
  }
}

// ── 与本机个人助手的通信桥：读 memory/bridge/to-qq.jsonl，真发到 QQ（与发件箱同一机制）──
const bridgeOutPath = path.join(root, "memory", "bridge", "to-qq.jsonl");

async function flushBridgeOut(): Promise<void> {
  if (!existsSync(bridgeOutPath)) return;
  let lines: string[] = [];
  try {
    lines = readFileSync(bridgeOutPath, "utf8").split("\n").filter((x) => x.trim());
  } catch {
    return;
  }
  if (lines.length === 0) return;
  try {
    writeFileSync(bridgeOutPath, "");
  } catch {
    return;
  }
  for (const line of lines) {
    try {
      const item = JSON.parse(line) as { type?: string; id?: string; target?: { type?: string; id?: string }; text?: string };
      const kind = String(item.type ?? item.target?.type ?? "group");
      const id = String(item.id ?? item.target?.id ?? config.bot.defaultGroup ?? "");
      const body = cleanIncomingText(String(item.text ?? ""));
      if (!id || !body) continue;
      // PA 的完整报告（查证过程、进程号、路径）不整段转发：超长先让模型整理成简洁答复
      let send = body;
      if (needsPaCleanup(body)) {
        let compact = "";
        try {
          compact = await compactPaReply(body, (p, t) =>
            runPiText(p, t, modelRegistry[currentModel] || undefined), {
            via: kind === "private" ? `private:${id}` : `group:${id}`,
            maxChars: PA_REPLY_MAX_CHARS,
          });
        } catch (err) {
          log("[bridge] 整理失败，改发原文:", err instanceof Error ? err.message : err);
        }
        // 短到不像答复（模型没好好输出）就按失败处理，宁发原文不丢内容
        if (compact.length >= 6) send = cleanIncomingText(compact);
        log(`[bridge] 长回复整理 ${body.length} → ${send === body ? "失败，原样发送" : send.length}`);
      }
      for (const chunk of splitText(send)) {
        await client.sendMessage(
          kind === "private"
            ? { message_type: "private", user_id: id, message: [textSegment(chunk)] }
            : { message_type: "group", group_id: id, message: [textSegment(chunk)] },
        );
      }
      if (kind !== "private") writeChatLine(id, config.bot.selfId, config.bot.nickname, body);
      log(`[bridge] 本机个人助手 -> ${kind} ${id}：${body.slice(0, 40)}`);
    } catch (err) {
      log("[bridge] 发送失败:", err instanceof Error ? err.message : err);
    }
  }
}

log("[main] pi-napcatqq bot 启动，白名单:", [...whitelist].join(", "));
log(`[media] 娱乐群图片理解${config.entertainment?.media?.enabled === false ? "关闭" : "开启"}（仅新消息；每条最多 3 图，后台不主动发言）`);
log("[modes] v2 模式隔离已启用（切换取消旧任务、双向历史隔离、内部协议防漏）");
if (config.jw?.className) setClassFilter(config.jw.className);
setInterval(() => refreshAllRosters().catch(() => {}), 10 * 60_000).unref();
setInterval(cleanupMemoryArchives, 30 * 60_000).unref();
setInterval(cleanupChatLogs, 6 * 3600_000).unref();
setInterval(() => attachments.cleanup(), 15 * 60_000).unref();
setInterval(() => flushOutbox().catch(() => {}), 3000).unref();
setInterval(() => flushBridgeOut().catch(() => {}), 3000).unref();
cleanupChatLogs();
attachments.cleanup();
// 内存监控：每小时记录一次桥接进程的常驻内存，便于发现异常增长
setInterval(() => {
  const mb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  log(`[mem] 桥接常驻内存 ${mb}MB`);
}, 3600_000).unref();
refreshScheduleAll().catch(() => {});
setInterval(() => refreshScheduleAll().catch(() => {}), 6 * 3600_000).unref();
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  taskScheduler.stop();
  modeTurns.close();
  client.close();
  await mediaContext.close();
  await runner.close();
  await knowledge?.close();
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void shutdown().catch(() => process.exit(1)); });
}
await connectLoop();
