import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PiRunner, type PiResult, type PiRunnerOptions } from "../src/runner.ts";

// 用法：node scripts/runner-selftest.ts。只启动 Node fixture，所有事件文件均在临时目录。
const fixture = fileURLToPath(new URL("./fixtures/pi-runner-fixture.mjs", import.meta.url));
const script = fileURLToPath(import.meta.url);
const temp = mkdtempSync(path.join(os.tmpdir(), "pi-runner-selftest-"));
const runners = new Set<PiRunner>();
let sequence = 0;
const knowledgeTools = [
  "web_search", "web_read", "current_time", "memory_search", "memory_get", "memory_save", "memory_correct", "memory_forget",
];

type Event = { id: string; pid: number; args: string[]; env: Record<string, string>; type: string; time: number };
const prompt = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ id, ...extra });

function create(overrides: Partial<PiRunnerOptions> = {}) {
  const cwd = path.join(temp, `runner-${++sequence}`);
  mkdirSync(cwd);
  const eventFile = path.join(cwd, "fixture-events.jsonl");
  const runner = new PiRunner({
    command: process.execPath, args: [fixture, "-p"], thinking: "", cwd, maxConcurrent: 2, timeoutMs: 5_000,
    ...overrides, env: { SELFTEST_EVENT_FILE: eventFile, ...overrides.env },
  });
  runners.add(runner);
  return { runner, eventFile, cwd };
}

function events(file: string): Event[] {
  try {
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function until(check: () => boolean, message: string, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`等待失败: ${message}`);
    await delay(15);
  }
}

async function started(file: string, id: string): Promise<Event> {
  await until(() => events(file).some((e) => e.type === "start" && e.id === id), `fixture ${id} 启动`);
  return events(file).find((e) => e.type === "start" && e.id === id)!;
}

async function bounded<T>(promise: Promise<T>, ms = 8_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("任务未在自测限时内完成")), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

function echo(result: PiResult): Event {
  assert.equal(result.ok, true, result.text);
  return JSON.parse(result.text);
}

function hasKnowledgeEnv(env: Record<string, string>): boolean {
  return Object.keys(env).some((key) => ["QQ_KNOWLEDGE_ENDPOINT", "QQ_KNOWLEDGE_TOKEN"].includes(key.toUpperCase()));
}

function noCredentials(event: Event) { assert.equal(hasKnowledgeEnv(event.env), false); }
function starts(file: string) { return events(file).filter((e) => e.type === "start").map((e) => e.id); }
function tools(event: Event) { return event.args[event.args.indexOf("--tools") + 1].split(","); }
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const inheritedProbe = async () => {
  const { runner } = create({ env: { SELFTEST_VALUE: "global-value" } });
  for (const mode of ["knowledge", "none", "web", "full"] as const) {
    const event = echo(await runner.run(prompt(mode), { mode }));
    noCredentials(event);
    assert.equal(event.env.SELFTEST_INHERITED, "synthetic-inherited");
    assert.equal(event.env.SELFTEST_VALUE, "global-value");
  }
  const event = echo(await runner.run(prompt("own-token"), {
    mode: "knowledge", env: { SELFTEST_VALUE: "task-value", QQ_KNOWLEDGE_ENDPOINT: "synthetic-task-endpoint", QQ_KNOWLEDGE_TOKEN: "synthetic-task-token" },
  }));
  assert.equal(event.env.SELFTEST_VALUE, "task-value");
  assert.equal(event.env.QQ_KNOWLEDGE_TOKEN, "synthetic-task-token");
  assert.equal(event.env.QQ_KNOWLEDGE_ENDPOINT, "synthetic-task-endpoint");
  // 这些值只来自自测父进程注入的合成凭据，不读取真实密钥。
  assert.equal(process.env.QQ_KNOWLEDGE_TOKEN, "synthetic-inherited-token");
  assert.equal(process.env.QQ_KNOWLEDGE_ENDPOINT, "synthetic-inherited-endpoint");
};

const tests: Array<[string, () => Promise<void>]> = [
  ["旧 opts/run 调用兼容，默认 web，无 session，保留其他参数", async () => {
    const { runner } = create({ args: [fixture, "-p", "--approve", "--no-tools", "--session=obsolete"], thinking: "low" });
    const event = echo(await runner.run(prompt("default"), { model: "synthetic-model", imagePaths: ["synthetic-image.png"] }));
    assert.ok(tools(event).includes("web_search"));
    assert.ok(!event.args.includes("--no-tools"));
    assert.ok(!event.args.includes("--session"));
    assert.equal(event.args.filter((a) => a === "--no-session").length, 1);
    assert.ok(event.args.includes("-p") && event.args.includes("--approve"));
    assert.equal(event.args[event.args.indexOf("--thinking") + 1], "low");
    assert.equal(event.args[event.args.indexOf("--model") + 1], "synthetic-model");
    assert.equal(event.args.at(-2), "@synthetic-image.png");
  }],
  ["knowledge 严格八项白名单，清理 paired/equals 参数冲突", async () => {
    const { runner } = create({ args: [fixture, "-p", "--tools", "send_group_message,remember", "--tools=recall", "--no-tools", "--no-tools=true", "--session", "old-session", "--session=other-session", "--no-session", "--no-session=true", "--approve"] });
    const event = echo(await runner.run(prompt("knowledge"), { mode: "knowledge" }));
    assert.deepEqual(tools(event), knowledgeTools);
    assert.equal(event.args.filter((a) => a === "--tools").length, 1);
    assert.equal(event.args.filter((a) => a === "--no-session").length, 1);
    for (const stale of ["--no-tools", "old-session", "other-session", "send_group_message,remember"]) assert.ok(!event.args.includes(stale));
    assert.ok(!event.args.some((a) => a.startsWith("--tools=") || a.startsWith("--session=") || a.startsWith("--no-tools=")));
    assert.ok(event.args.includes("-p") && event.args.includes("--approve"));
  }],
  ["none 强制 no-tools，可显式 session 用于摘要", async () => {
    const { runner } = create({ args: [fixture, "-p", "--tools=remember", "--no-session", "--session", "obsolete"] });
    const event = echo(await runner.run(prompt("summary"), { mode: "none", sessionFile: "synthetic-summary-session" }));
    assert.equal(event.args.filter((a) => a === "--no-tools").length, 1);
    assert.ok(!event.args.includes("--tools") && !event.args.includes("--no-session"));
    assert.equal(event.args[event.args.indexOf("--session") + 1], "synthetic-summary-session");
    assert.ok(!event.args.includes("obsolete"));
  }],
  ["none 禁扩展并移除显式加载及短工具别名，拒绝选项终止符绕过", async () => {
    const { runner } = create({ args: [fixture, "-p", "--approve", "--extension", "synthetic-a.ts", "-e", "synthetic-b.ts", "--extension=synthetic-c.ts", "-e=synthetic-d.ts", "-t", "bash", "-t=send_group_message", "-nt", "-nt=true"] });
    const event = echo(await runner.run(prompt("none-no-extensions"), { mode: "none", priority: "background" }));
    assert.equal(event.args.filter((arg) => arg === "--no-tools").length, 1);
    assert.equal(event.args.filter((arg) => arg === "--no-extensions").length, 1);
    assert.ok(event.args.includes("--no-session"));
    assert.ok(event.args.includes("-p") && event.args.includes("--approve"));
    assert.ok(!event.args.some((arg) => ["--extension", "-e", "--tools", "-t", "-nt"].includes(arg.split("=", 1)[0])));
    for (const value of ["synthetic-a.ts", "synthetic-b.ts", "synthetic-c.ts", "synthetic-d.ts", "bash"]) assert.ok(!event.args.includes(value));
    assert.throws(() => create({ args: [fixture, "-p", "--"] }), /选项终止符/);
  }],
  ["none session 摘要保留历史路径并发出禁扩展参数", async () => {
    const { runner } = create({ args: [fixture, "-p", "--extension", "synthetic-summary-hook.ts", "-e=synthetic-other-hook.ts", "--session=obsolete"] });
    const event = echo(await runner.run(prompt("none-summary"), { mode: "none", sessionFile: "synthetic-summary-session" }));
    assert.ok(event.args.includes("--no-tools") && event.args.includes("--no-extensions"));
    assert.equal(event.args[event.args.indexOf("--session") + 1], "synthetic-summary-session");
    assert.ok(!event.args.includes("--no-session"));
    assert.ok(!event.args.some((arg) => arg.includes("synthetic-summary-hook") || arg.includes("synthetic-other-hook")));
  }],
  ["knowledge/web/full 保留所有原扩展路径，不自动添加禁扩展参数", async () => {
    const extensionArgs = ["--extension", "synthetic-a.ts", "-e", "synthetic-b.ts", "--extension=synthetic-c.ts", "-e=synthetic-d.ts"];
    const { runner } = create({ args: [fixture, "-p", ...extensionArgs] });
    for (const mode of ["knowledge", "web", "full"] as const) {
      const event = echo(await runner.run(prompt(`${mode}-extensions`), { mode }));
      assert.deepEqual(event.args.slice(1, 1 + extensionArgs.length), extensionArgs);
      assert.ok(!event.args.includes("--no-extensions") && !event.args.includes("-ne"));
      if (mode === "knowledge") assert.deepEqual(tools(event), knowledgeTools);
    }
  }],
  ["full 仅显式可选，不带 knowledge token", async () => {
    const { runner } = create({ args: [fixture, "-p", "--tools", "remember", "--no-tools"], env: { QQ_KNOWLEDGE_TOKEN: "synthetic-global" } });
    const event = echo(await runner.run(prompt("full"), { mode: "full", env: { QQ_KNOWLEDGE_TOKEN: "synthetic-task", QQ_KNOWLEDGE_ENDPOINT: "synthetic-endpoint" } }));
    assert.ok(!event.args.includes("--tools") && !event.args.includes("--no-tools"));
    noCredentials(event);
  }],
  ["每 run env 合并、快照与 token 顺序隔离", async () => {
    const { runner } = create({ env: { SELFTEST_GLOBAL: "global", SELFTEST_VALUE: "global", QQ_KNOWLEDGE_TOKEN: "synthetic-global", qq_knowledge_endpoint: "synthetic-global-endpoint" } });
    for (const token of ["A", "B"]) {
      const event = echo(await runner.run(prompt(token), { mode: "knowledge", env: { SELFTEST_VALUE: token, QQ_KNOWLEDGE_ENDPOINT: `synthetic-${token}`, QQ_KNOWLEDGE_TOKEN: token } }));
      assert.equal(event.env.SELFTEST_GLOBAL, "global");
      assert.equal(event.env.SELFTEST_VALUE, token);
      assert.equal(event.env.QQ_KNOWLEDGE_TOKEN, token);
      assert.equal(event.env.QQ_KNOWLEDGE_ENDPOINT, `synthetic-${token}`);
      assert.ok(!("qq_knowledge_endpoint" in event.env));
    }
    noCredentials(echo(await runner.run(prompt("knowledge-no-token"), { mode: "knowledge" })));
    for (const mode of ["none", "web", "full"] as const) {
      noCredentials(echo(await runner.run(prompt(mode), { mode, env: { qq_knowledge_token: "synthetic-lowercase", QQ_KNOWLEDGE_ENDPOINT: "synthetic-endpoint" } })));
    }
    noCredentials(echo(await runner.run(prompt("background"), { mode: "none", priority: "background", env: { QQ_KNOWLEDGE_TOKEN: "synthetic-background" } })));
  }],
  ["并行 knowledge 任务 token 与普通任务隔离", async () => {
    const { runner } = create({ maxConcurrent: 3 });
    const results = await Promise.all([
      runner.run(prompt("A", { waitMs: 100 }), { mode: "knowledge", env: { QQ_KNOWLEDGE_TOKEN: "A" } }),
      runner.run(prompt("B", { waitMs: 100 }), { mode: "knowledge", env: { QQ_KNOWLEDGE_TOKEN: "B" } }),
      runner.run(prompt("entertainment"), { mode: "none", env: { QQ_KNOWLEDGE_TOKEN: "must-not-leak" } }),
    ]);
    assert.equal(echo(results[0]).env.QQ_KNOWLEDGE_TOKEN, "A");
    assert.equal(echo(results[1]).env.QQ_KNOWLEDGE_TOKEN, "B");
    noCredentials(echo(results[2]));
  }],
  ["process.env 继承凭据也被移除，不修改父进程环境", async () => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("QQ_KNOWLEDGE_")) delete env[key];
    env.QQ_KNOWLEDGE_TOKEN = "synthetic-inherited-token";
    env.QQ_KNOWLEDGE_ENDPOINT = "synthetic-inherited-endpoint";
    env.SELFTEST_INHERITED = "synthetic-inherited";
    env.SELFTEST_VALUE = "inherited-value";
    const child = spawn(process.execPath, [script, "--inherited-probe"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
    const code = await bounded(new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }), 15_000);
    assert.equal(code, 0, output);
    assert.ok(output.includes("inherited probe PASS"), output);
  }],
  ["三层排队优先级 interactive > scheduled > background", async () => {
    const { runner, eventFile } = create({ maxConcurrent: 1 });
    const controller = new AbortController();
    const blocker = runner.run(prompt("blocker", { waitMs: 60_000 }), { signal: controller.signal });
    await started(eventFile, "blocker");
    const jobs = [
      runner.run(prompt("b1"), { priority: "background" }), runner.run(prompt("s1"), { priority: "scheduled" }),
      runner.run(prompt("i1")), runner.run(prompt("b2"), { priority: "background" }), runner.run(prompt("s2"), { priority: "scheduled" }), runner.run(prompt("i2")),
    ];
    controller.abort();
    assert.equal((await bounded(blocker)).ok, false);
    (await bounded(Promise.all(jobs))).forEach(echo);
    assert.deepEqual(starts(eventFile), ["blocker", "i1", "i2", "s1", "s2", "b1", "b2"]);
  }],
  ["后台最多一项且不占交互槽", async () => {
    const { runner, eventFile } = create({ maxConcurrent: 3 });
    const controller = new AbortController();
    const first = runner.run(prompt("b1", { waitMs: 60_000 }), { mode: "none", priority: "background", signal: controller.signal });
    await started(eventFile, "b1");
    const second = runner.run(prompt("b2"), { mode: "none", priority: "background" });
    const interactive = echo(await bounded(runner.run(prompt("i1"))));
    assert.equal(interactive.id, "i1");
    assert.deepEqual(starts(eventFile), ["b1", "i1"]);
    controller.abort();
    assert.equal((await bounded(first)).ok, false);
    const background = echo(await bounded(second));
    assert.ok(background.args.includes("--no-session"));
    assert.ok(!background.args.includes("--session"));
  }],
  ["scheduled 已占位时后台不取最后空槽（并发 2 和 3）", async () => {
    for (const maxConcurrent of [2, 3]) {
      const { runner, eventFile } = create({ maxConcurrent });
      const controller = new AbortController();
      const scheduled = Array.from({ length: maxConcurrent - 1 }, (_, i) => runner.run(prompt(`s${i}`, { waitMs: 60_000 }), { priority: "scheduled", signal: controller.signal }));
      for (let i = 0; i < scheduled.length; i++) await started(eventFile, `s${i}`);
      const background = runner.run(prompt("background"), { priority: "background", mode: "none" });
      assert.equal(echo(await bounded(runner.run(prompt("interactive")))).id, "interactive");
      assert.ok(!starts(eventFile).includes("background"));
      controller.abort();
      (await bounded(Promise.all(scheduled))).forEach((r) => assert.equal(r.ok, false));
      echo(await bounded(background));
    }
  }],
  ["单并发空闲允许后台，新交互取消后台并恢复槽", async () => {
    const { runner, eventFile } = create({ maxConcurrent: 1 });
    let resolved = 0;
    const background = runner.run(prompt("background", { waitMs: 60_000 }), { priority: "background", mode: "none" }).then((result) => { resolved++; return result; });
    const running = await started(eventFile, "background");
    const interactive = runner.run(prompt("interactive"));
    const result = await bounded(background);
    assert.equal(result.ok, false);
    assert.match(result.text, /让位/);
    assert.equal(echo(await bounded(interactive)).id, "interactive");
    await until(() => !alive(running.pid), "被抢占 fixture 退出");
    assert.equal(resolved, 1);
  }],
  ["排队 abort 不启动、只 resolve 一次并移除 listener", async () => {
    const { runner, eventFile } = create({ maxConcurrent: 1 });
    const activeController = new AbortController();
    const active = runner.run(prompt("blocker", { waitMs: 60_000 }), { signal: activeController.signal });
    await started(eventFile, "blocker");
    const controller = new AbortController();
    let resolved = 0;
    const queued = runner.run(prompt("queued"), { signal: controller.signal }).then((r) => { resolved++; return r; });
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    controller.abort(); controller.abort();
    assert.equal((await bounded(queued)).ok, false);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.deepEqual(starts(eventFile), ["blocker"]);
    activeController.abort(); await bounded(active);
    echo(await bounded(runner.run(prompt("after"))));
    assert.equal(resolved, 1);
    assert.ok(!starts(eventFile).includes("queued"));
  }],
  ["运行 abort 终止 fixture，释放计数和 listener", async () => {
    const { runner, eventFile } = create({ maxConcurrent: 1 });
    const controller = new AbortController();
    let resolved = 0;
    const running = runner.run(prompt("running", { waitMs: 60_000 }), { signal: controller.signal }).then((r) => { resolved++; return r; });
    const event = await started(eventFile, "running");
    const next = runner.run(prompt("next"));
    controller.abort(); controller.abort();
    assert.equal((await bounded(running)).ok, false);
    echo(await bounded(next));
    await until(() => !alive(event.pid), "取消的 fixture 退出");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(resolved, 1);
  }],
  ["已 abort 的 signal 不入队、不启动", async () => {
    const { runner, eventFile } = create();
    const controller = new AbortController(); controller.abort();
    const result = await runner.run(prompt("never-start"), { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.durationMs, 0);
    assert.deepEqual(events(eventFile), []);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }],
  ["逐任务 timeout 覆盖默认并 kill fixture，下一任务可运行", async () => {
    const { runner, eventFile } = create({ maxConcurrent: 1, timeoutMs: 5_000 });
    const controller = new AbortController();
    let resolved = 0;
    const running = runner.run(prompt("timeout", { waitMs: 60_000 }), { timeoutMs: 600, signal: controller.signal }).then((r) => { resolved++; return r; });
    const event = await started(eventFile, "timeout");
    const next = runner.run(prompt("next"));
    const result = await bounded(running);
    assert.equal(result.ok, false);
    assert.match(result.text, /超时.*600/);
    assert.ok(result.durationMs >= 550 && result.durationMs < 3_500);
    echo(await bounded(next));
    controller.abort();
    assert.equal(resolved, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await until(() => !alive(event.pid), "超时 fixture 退出");
  }],
  ["timeout 和 abort 只终止 fixture 及其后代进程树", async () => {
    for (const cause of ["timeout", "abort"]) {
      const { runner, eventFile } = create();
      const controller = new AbortController();
      const running = runner.run(prompt(cause, { waitMs: 60_000, descendant: true }), {
        timeoutMs: cause === "timeout" ? 1_500 : 5_000, signal: controller.signal,
      });
      const parent = await started(eventFile, cause);
      const descendant = await started(eventFile, `${cause}-descendant`);
      if (cause === "abort") controller.abort();
      assert.equal((await bounded(running)).ok, false);
      await until(() => !alive(parent.pid) && !alive(descendant.pid), `${cause} fixture 进程树退出`);
    }
  }],
  ["runner 默认 timeout 生效", async () => {
    const { runner } = create({ timeoutMs: 600 });
    const result = await bounded(runner.run(prompt("default-timeout", { waitMs: 60_000 })));
    assert.equal(result.ok, false);
    assert.match(result.text, /超时.*600/);
  }],
  ["缺失 close 事件时超时兜底释放任务和并发槽", async () => {
    const { runner, eventFile } = create({ maxConcurrent: 1 });
    const running = runner.run(prompt("missing-close", { waitMs: 60_000 }), { timeoutMs: 800 });
    const event = await started(eventFile, "missing-close");
    // 仅屏蔽这个 fixture 的 close 事件，不修改 spawn，也不影响 taskkill 或其他进程。
    const original = ChildProcess.prototype.emit;
    ChildProcess.prototype.emit = function (name: string | symbol, ...args: unknown[]) {
      if (name === "close" && this.pid === event.pid) return false;
      return original.call(this, name, ...args);
    };
    try {
      const next = runner.run(prompt("after-fallback"));
      const result = await bounded(running);
      assert.equal(result.ok, false);
      assert.match(result.text, /超时/);
      assert.ok(result.durationMs >= 1_700 && result.durationMs < 4_000);
      echo(await bounded(next));
      await until(() => !alive(event.pid), "兜底 fixture 退出");
      await bounded(runner.close());
    } finally { ChildProcess.prototype.emit = original; }
  }],
  ["启动失败清理计数，修复合成 cwd 后同 runner 恢复", async () => {
    const missing = path.join(temp, `missing-${sequence + 1}`);
    const { runner } = create({ cwd: missing, maxConcurrent: 1 });
    const results = await bounded(Promise.all([runner.run(prompt("fail1")), runner.run(prompt("fail2"))]));
    results.forEach((r) => { assert.equal(r.ok, false); assert.match(r.text, /无法启动/); });
    mkdirSync(missing);
    assert.equal(echo(await bounded(runner.run(prompt("recovered")))).id, "recovered");
  }],
  ["同步 spawn 异常也释放槽，不悬挂关闭", async () => {
    const { runner } = create({ command: "synthetic\u0000invalid-command", maxConcurrent: 1 });
    const results = await bounded(Promise.all([runner.run(prompt("sync1")), runner.run(prompt("sync2"))]));
    results.forEach((r) => { assert.equal(r.ok, false); assert.match(r.text, /无法启动/); });
    await bounded(runner.close());
  }],
  ["队列有上限，满队列不增加 abort listener", async () => {
    const { runner, eventFile } = create({ maxConcurrent: 1, maxQueue: 2 });
    const active = runner.run(prompt("active", { waitMs: 60_000 }));
    await started(eventFile, "active");
    const q1 = runner.run(prompt("q1"));
    const q2 = runner.run(prompt("q2"), { priority: "background" });
    const controller = new AbortController();
    const rejected = await runner.run(prompt("overflow"), { signal: controller.signal });
    assert.equal(rejected.ok, false); assert.match(rejected.text, /排队已满/);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await bounded(runner.close());
    (await bounded(Promise.all([active, q1, q2]))).forEach((r) => assert.equal(r.ok, false));
    assert.deepEqual(starts(eventFile), ["active"]);
  }],
  ["cancel 同时取消运行/排队，可重复调用并再次 run", async () => {
    const { runner, eventFile } = create({ maxConcurrent: 1 });
    const activeSignal = new AbortController();
    const queuedSignal = new AbortController();
    let resolved = 0;
    const count = (r: PiResult) => { resolved++; return r; };
    const active = runner.run(prompt("active", { waitMs: 60_000 }), { signal: activeSignal.signal }).then(count);
    await started(eventFile, "active");
    const queued = runner.run(prompt("queued"), { signal: queuedSignal.signal }).then(count);
    runner.cancel("synthetic-cancel"); runner.cancel("duplicate");
    (await bounded(Promise.all([active, queued]))).forEach((r) => { assert.equal(r.ok, false); assert.equal(r.text, "synthetic-cancel"); });
    assert.equal(resolved, 2);
    assert.equal(getEventListeners(activeSignal.signal, "abort").length, 0);
    assert.equal(getEventListeners(queuedSignal.signal, "abort").length, 0);
    echo(await bounded(runner.run(prompt("usable-again"))));
    assert.ok(!starts(eventFile).includes("queued"));
  }],
  ["close 幂等、取消所有任务、拒绝未来 run", async () => {
    const { runner, eventFile } = create({ maxConcurrent: 2 });
    const a = runner.run(prompt("a", { waitMs: 60_000 }));
    const b = runner.run(prompt("b", { waitMs: 60_000 }));
    const ea = await started(eventFile, "a"); const eb = await started(eventFile, "b");
    const queued = runner.run(prompt("queued"));
    await bounded(Promise.all([runner.close(), runner.close()]));
    (await bounded(Promise.all([a, b, queued]))).forEach((r) => assert.equal(r.ok, false));
    assert.equal((await runner.run(prompt("after-close"))).ok, false);
    await until(() => !alive(ea.pid) && !alive(eb.pid), "关闭的 fixture 全部退出");
    assert.ok(!starts(eventFile).includes("queued"));
  }],
  ["MAX_CAPTURE 字节有界、多字节截断安全、失败诊断有界", async () => {
    const { runner } = create();
    const result = await runner.run(prompt("large-output", { repeat: { text: "界🙂", count: 100_000 } }));
    assert.equal(result.ok, true, result.text.slice(0, 100));
    assert.ok(Buffer.byteLength(result.text) <= 200_000);
    assert.ok(Buffer.byteLength(result.text) >= 199_990);
    assert.ok(!result.text.includes("\ufffd"));
    const failed = await runner.run(prompt("large-stderr", { output: "", stderrRepeat: { text: "界🙂", count: 100_000 }, exitCode: 7 }));
    assert.equal(failed.ok, false);
    assert.ok(failed.text.length <= 2_020);
    assert.ok(!failed.text.includes("\ufffd"));
  }],
  ["close 收集完整 stdout，空输出和非零退出正确失败", async () => {
    const { runner } = create();
    const output = "synthetic-output-".repeat(5_000);
    const success = await runner.run(prompt("flush", { repeat: { text: "synthetic-output-", count: 5_000 } }));
    assert.equal(success.ok, true, success.text); assert.equal(success.text, output);
    const empty = await runner.run(prompt("empty", { output: "" }));
    assert.equal(empty.ok, false); assert.match(empty.text, /退出码 0/);
    const failure = await runner.run(prompt("failure", { stderr: "synthetic diagnostic", exitCode: 7 }));
    assert.equal(failure.ok, false); assert.match(failure.text, /synthetic diagnostic/);
  }],
  ["排队任务 env/imagePaths 使用提交时快照", async () => {
    const { runner, eventFile } = create({ maxConcurrent: 1 });
    const controller = new AbortController();
    const active = runner.run(prompt("blocker", { waitMs: 60_000 }), { signal: controller.signal });
    await started(eventFile, "blocker");
    const env = { QQ_KNOWLEDGE_TOKEN: "original", SELFTEST_VALUE: "original" };
    const imagePaths = ["original.png"];
    const queued = runner.run(prompt("snapshot"), { mode: "knowledge", env, imagePaths });
    env.QQ_KNOWLEDGE_TOKEN = "mutated"; env.SELFTEST_VALUE = "mutated"; imagePaths[0] = "mutated.png";
    controller.abort(); await bounded(active);
    const event = echo(await bounded(queued));
    assert.equal(event.env.QQ_KNOWLEDGE_TOKEN, "original");
    assert.equal(event.env.SELFTEST_VALUE, "original");
    assert.ok(event.args.includes("@original.png") && !event.args.includes("@mutated.png"));
  }],
  ["无效 timeout 拒绝但不占槽，不影响后续 run", async () => {
    const { runner } = create();
    for (const timeoutMs of [0, -1, NaN, Infinity, 2_147_483_648]) {
      assert.equal((await runner.run(prompt("invalid-timeout"), { timeoutMs })).ok, false);
    }
    echo(await bounded(runner.run(prompt("valid"))));
  }],
];

async function cleanup() {
  await bounded(Promise.all([...runners].map((runner) => runner.close())), 10_000);
  runners.clear();
}

try {
  if (process.argv.includes("--inherited-probe")) {
    await inheritedProbe();
    console.log("inherited probe PASS");
  } else {
    let passed = 0;
    let failed = 0;
    for (const [name, run] of tests) {
      try {
        await run();
        passed++;
        console.log(`PASS ${name}`);
      } catch (err) {
        failed++;
        console.error(`FAIL ${name}\n${err instanceof Error ? err.stack : String(err)}`);
      } finally { await cleanup(); }
    }
    console.log(`runner-selftest: ${passed}/${tests.length} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  }
} finally {
  await cleanup();
  rmSync(temp, { recursive: true, force: true });
}
