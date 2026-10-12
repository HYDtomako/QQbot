import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface PiResult {
  ok: boolean;
  text: string;
  durationMs: number;
}

export type PiMode = "full" | "web" | "none" | "knowledge";
export type PiPriority = "interactive" | "scheduled" | "background";

export interface PiRunOptions {
  mode?: PiMode;
  model?: string;
  sessionFile?: string;
  imagePaths?: string[];
  priority?: PiPriority;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PiRunnerOptions {
  command: string;
  args: string[];
  thinking: string;
  env?: Record<string, string>;
  cwd: string;
  maxConcurrent: number;
  timeoutMs: number;
  maxQueue?: number;
}

interface Job {
  prompt: string;
  options: PiRunOptions;
  mode: PiMode;
  priority: PiPriority;
  state: "queued" | "running" | "settled";
  started: number;
  promise: Promise<PiResult>;
  resolve: (r: PiResult) => void;
  abortListener?: () => void;
  cancelRun?: (reason: string) => void;
}

const MAX_CAPTURE = 200_000; // 每个输出流最多保留这些字节，包含单次大块输出
const CLOSE_GRACE_MS = 1_000; // kill 后即使没有 close 事件，也释放任务和并发槽
const KNOWLEDGE_KEYS = new Set(["QQ_KNOWLEDGE_ENDPOINT", "QQ_KNOWLEDGE_TOKEN"]);
const KNOWLEDGE_TOOLS = "web_search,web_read,current_time,memory_search,memory_get,memory_save,memory_correct,memory_forget";
const WEB_TOOLS = "web_search,web_read,group_members,member_info,schedule_query,chat_digest,task_manage,remember,recall,forget,current_time,send_group_message,model_manage,tell_guga";

/** 去除配置中旧的工具/会话参数；任务参数是唯一权威来源。 */
function normalizeArgs(args: string[], withoutExtensions = false): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    // pi 在 -- 后停止解析；不能允许配置将任务权限参数变成普通 prompt。
    if (args[i] === "--") throw new Error("runner 基础 args 不允许 -- 选项终止符");
    const flag = args[i].split("=", 1)[0];
    if (flag === "--tools" || flag === "-t" || flag === "--session"
      || (withoutExtensions && (flag === "--extension" || flag === "-e"))) {
      if (!args[i].includes("=") && args[i + 1] !== undefined && !args[i + 1].startsWith("-")) i++;
    } else if (flag !== "--no-tools" && flag !== "-nt" && flag !== "--no-session") {
      result.push(args[i]);
    }
  }
  return result;
}

function taskEnv(globalEnv: Record<string, string> | undefined, job: Job): NodeJS.ProcessEnv {
  const env = { ...process.env, ...globalEnv, ...job.options.env };
  // Windows 环境变量名不区分大小写，必须同时清理大小写变体。
  for (const key of Object.keys(env)) {
    if (KNOWLEDGE_KEYS.has(key.toUpperCase())) delete env[key];
  }
  if (job.mode === "knowledge") {
    // 只能从该任务取得凭据，绝不回退到 runner 或 process 的环境。
    for (const [key, value] of Object.entries(job.options.env ?? {})) {
      if (KNOWLEDGE_KEYS.has(key.toUpperCase())) env[key.toUpperCase()] = value;
    }
  }
  return env;
}

class LimitedCapture {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private truncated = false;

  append(chunk: Buffer): void {
    const remaining = MAX_CAPTURE - this.bytes;
    if (chunk.length > remaining) this.truncated = true;
    if (remaining <= 0) return;
    const part = Buffer.from(chunk.subarray(0, remaining));
    this.chunks.push(part);
    this.bytes += part.length;
  }

  text(): string {
    const decoder = new StringDecoder("utf8");
    const text = decoder.write(Buffer.concat(this.chunks, this.bytes));
    // 截断在多字节字符中间时丢弃残片，不输出替换字符。
    return text + (this.truncated ? "" : decoder.end());
  }
}

/** 每个任务单独 spawn pi，交互 > 定时 > 后台；默认 web、无 session。 */
export class PiRunner {
  private readonly opts: PiRunnerOptions;
  private readonly queues: Record<PiPriority, Job[]> = { interactive: [], scheduled: [], background: [] };
  private readonly active = new Set<Job>();
  private closed = false;
  private cancelling = false;

  constructor(opts: PiRunnerOptions) {
    if (!Number.isInteger(opts.maxConcurrent) || opts.maxConcurrent < 1) {
      throw new RangeError("maxConcurrent 必须是正整数");
    }
    if (!validTimeout(opts.timeoutMs)) throw new RangeError("timeoutMs 必须是有效的正毫秒数");
    if (opts.maxQueue !== undefined && (!Number.isInteger(opts.maxQueue) || opts.maxQueue < 1)) {
      throw new RangeError("maxQueue 必须是正整数");
    }
    this.opts = { ...opts, args: normalizeArgs(opts.args), env: { ...opts.env }, maxQueue: opts.maxQueue ?? 128 };
  }

  run(prompt: string, options: PiRunOptions = {}): Promise<PiResult> {
    const rejected = (text: string) => Promise.resolve({ ok: false, text, durationMs: 0 });
    if (this.closed) return rejected("runner 已关闭");
    if (options.signal?.aborted) return rejected("任务已取消");
    if (options.timeoutMs !== undefined && !validTimeout(options.timeoutMs)) return rejected("无效的任务 timeoutMs");
    const mode = options.mode ?? "web";
    const priority = options.priority ?? "interactive";
    if (!["full", "web", "none", "knowledge"].includes(mode) || !Object.hasOwn(this.queues, priority)) {
      return rejected("无效的任务 mode 或 priority");
    }
    if (this.queuedJobs().length >= this.opts.maxQueue!) return rejected("runner 排队已满");

    let resolve!: (r: PiResult) => void;
    const promise = new Promise<PiResult>((done) => { resolve = done; });
    const job: Job = {
      prompt,
      options: { ...options, env: { ...options.env }, imagePaths: options.imagePaths?.slice() },
      mode, priority, state: "queued", started: 0, promise, resolve,
    };
    if (options.signal) {
      job.abortListener = () => this.cancelJob(job, "任务已取消");
      options.signal.addEventListener("abort", job.abortListener, { once: true });
    }
    this.queues[priority].push(job);
    // 单并发下只允许交互任务抢占后台；被取消的后台由外部 worker 决定重试。
    if (priority === "interactive" && this.opts.maxConcurrent === 1) {
      for (const running of this.active) {
        if (running.priority === "background") this.cancelJob(running, "后台任务已取消，为交互任务让位");
      }
    }
    this.pump();
    return promise;
  }

  /** 取消当前排队和运行中的任务；runner 仍可用于后续任务。 */
  cancel(reason = "任务已取消"): void {
    this.cancelling = true;
    try {
      for (const job of [...this.queuedJobs(), ...this.active]) this.cancelJob(job, reason);
    } finally {
      this.cancelling = false;
      this.pump();
    }
  }

  /** 永久关闭并等待当前任务完成清理，可重复调用。 */
  async close(reason = "runner 已关闭，任务已取消"): Promise<void> {
    this.closed = true;
    const pending = [...this.queuedJobs(), ...this.active].map((job) => job.promise);
    this.cancel(reason);
    await Promise.all(pending);
  }

  private queuedJobs(): Job[] {
    return [...this.queues.interactive, ...this.queues.scheduled, ...this.queues.background];
  }

  private cancelJob(job: Job, reason: string): void {
    if (job.state === "settled") return;
    if (job.state === "running") job.cancelRun?.(reason);
    else this.settle(job, { ok: false, text: reason, durationMs: 0 });
  }

  private settle(job: Job, result: PiResult): void {
    if (job.state === "settled") return;
    if (job.state === "queued") {
      const queue = this.queues[job.priority];
      const index = queue.indexOf(job);
      if (index !== -1) queue.splice(index, 1);
    }
    job.state = "settled";
    this.active.delete(job);
    if (job.abortListener) job.options.signal?.removeEventListener("abort", job.abortListener);
    job.abortListener = undefined;
    job.cancelRun = undefined;
    job.resolve(result);
    this.pump();
  }

  private pump(): void {
    if (this.closed || this.cancelling) return;
    while (this.active.size < this.opts.maxConcurrent) {
      let job = this.queues.interactive.shift() ?? this.queues.scheduled.shift();
      if (!job) {
        const hasBackground = [...this.active].some((running) => running.priority === "background");
        // 以总占位数判断，scheduled 已占位时后台也不能取走最后一槽。
        if (hasBackground || (this.opts.maxConcurrent >= 2 && this.active.size >= this.opts.maxConcurrent - 1)) return;
        job = this.queues.background.shift();
      }
      if (!job) return;
      job.state = "running";
      job.started = Date.now();
      this.active.add(job);
      try {
        this.execute(job);
      } catch (err) {
        this.settle(job, {
          ok: false,
          text: `无法启动 pi: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: Date.now() - job.started,
        });
      }
    }
  }

  private execute(job: Job): void {
    // --no-tools 限制工具注册表，但不会停止扩展的初始化或 hook 副作用。
    // none 必须禁自动发现，并移除显式 -e（它会覆盖 --no-extensions）。
    const args = job.mode === "none" ? normalizeArgs(this.opts.args, true) : [...this.opts.args];
    if (job.mode === "none") args.push("--no-tools", "--no-extensions");
    else if (job.mode === "knowledge") args.push("--tools", KNOWLEDGE_TOOLS);
    else if (job.mode === "web") args.push("--tools", WEB_TOOLS);
    if (this.opts.thinking) args.push("--thinking", this.opts.thinking);
    if (job.options.model) args.push("--model", job.options.model);
    if (job.options.sessionFile) args.push("--session", job.options.sessionFile);
    else args.push("--no-session");
    for (const p of job.options.imagePaths ?? []) args.push("@" + p);
    args.push(job.prompt);

    const child = spawn(this.opts.command, args, {
      cwd: this.opts.cwd,
      windowsHide: true,
      // POSIX 创建独立进程组，让 killTree 只终止该任务及其后代。
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: taskEnv(this.opts.env, job),
    });
    const stdout = new LimitedCapture();
    const stderr = new LimitedCapture();
    let failure: string | undefined;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = job.options.timeoutMs ?? this.opts.timeoutMs;

    const finish = (result: PiResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      this.settle(job, result);
    };
    const fail = (text: string) => finish({ ok: false, text, durationMs: Date.now() - job.started });
    const terminate = (reason: string) => {
      if (finished || failure !== undefined) return;
      failure = reason;
      clearTimeout(timer);
      killTree(child);
      closeTimer = setTimeout(() => {
        // 兜底：坏掉的 close/继承管道不能让任务、计数或 close() 永久悬挂。
        try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        fail(reason);
      }, CLOSE_GRACE_MS);
    };
    job.cancelRun = terminate;
    child.stdout!.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.once("error", (err) => fail(failure ?? `无法启动 pi: ${err.message}`));
    // close 而不是 exit：确保成功结果包含已经写出的完整 stdout。
    child.once("close", (code) => {
      if (failure !== undefined) return fail(failure);
      const text = stdout.text().trim();
      if (code === 0 && text) finish({ ok: true, text, durationMs: Date.now() - job.started });
      else fail(`pi 执行失败: ${(stderr.text().trim() || text || `退出码 ${code}`).slice(-2000)}`);
    });
    timer = setTimeout(() => terminate(`pi 处理超时（>${timeoutMs} 毫秒），已终止`), timeoutMs);
  }
}

function validTimeout(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 2_147_483_647;
}

/** 只结束本任务的进程树，不扫描或终止其他 pi/node 进程。 */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  const killChild = () => {
    try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
  };
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore",
      });
      killer.once("error", killChild);
      killer.once("exit", (code) => { if (code !== 0) killChild(); });
      killer.unref();
    } catch { killChild(); }
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { killChild(); }
  }
}
