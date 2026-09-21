import { spawn } from "node:child_process";

export interface PiResult {
  ok: boolean;
  text: string;
  durationMs: number;
}

interface Job {
  prompt: string;
  mode: "full" | "web";
  model?: string;
  sessionFile?: string;
  imagePaths?: string[];
  priority: "interactive" | "scheduled"; // 交互任务永远优先于定时任务
  resolve: (r: PiResult) => void;
}

const MAX_CAPTURE = 200_000; // stdout/stderr 最大收集字节数，防爆内存

/**
 * 无状态 pi 执行器：每条消息 spawn 一个 `pi -p --no-session` 子进程。
 * 并发数受限，超出部分排队。
 */
export class PiRunner {
  private readonly opts: {
    command: string;
    args: string[];
    thinking: string;
    env?: Record<string, string>;
    cwd: string;
    maxConcurrent: number;
    timeoutMs: number;
  };
  private queues: Record<"interactive" | "scheduled", Job[]> = { interactive: [], scheduled: [] };
  private active = 0;

  constructor(opts: PiRunner["opts"]) {
    this.opts = opts;
  }

  run(
    prompt: string,
    options?: {
      mode?: "full" | "web";
      model?: string;
      sessionFile?: string;
      imagePaths?: string[];
      priority?: "interactive" | "scheduled";
    },
  ): Promise<PiResult> {
    return new Promise((resolve) => {
      this.queues[options?.priority ?? "interactive"].push({
        prompt,
        mode: options?.mode ?? "full",
        model: options?.model,
        sessionFile: options?.sessionFile,
        imagePaths: options?.imagePaths,
        priority: options?.priority ?? "interactive",
        resolve,
      });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.opts.maxConcurrent) {
      // 交互流优先：只有没有交互任务在排队时，才轮到定时任务
      const job = this.queues.interactive.shift() ?? this.queues.scheduled.shift();
      if (!job) return;
      this.active++;
      this.execute(job)
        .catch((err) => ({
          ok: false,
          text: `执行异常: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: 0,
        }))
        .then((result) => {
          this.active--;
          job.resolve(result);
          this.pump();
        });
    }
  }

  private execute(job: Job): Promise<PiResult> {
    const started = Date.now();
    const args = [...this.opts.args];
    // 工具分级：full=全部工具；web=联网搜索/读链接 + 群名册 + 课表 + 群聊总结 + 定时任务 + 长期记忆 + 时间（无本地文件/命令）
    if (job.mode === "web")
      args.push(
        "--tools",
        "web_search,web_read,group_members,member_info,schedule_query,chat_digest,task_manage,remember,recall,forget,current_time,send_group_message,model_manage",
      );
    if (this.opts.thinking) args.push("--thinking", this.opts.thinking);
    if (job.model) args.push("--model", job.model);
    // 记忆：有会话文件则续接（pi 跨进程加载历史），否则无状态
    if (job.sessionFile) args.push("--session", job.sessionFile);
    else args.push("--no-session");
    // 图片：以 @路径 形式传入（pi 的多模态输入语法），须在提问之前
    for (const p of job.imagePaths ?? []) args.push("@" + p);
    args.push(job.prompt);

    // 直接 spawn（不经 shell/cmd），避免引号解析与编码问题
    const child = spawn(this.opts.command, args, {
      cwd: this.opts.cwd,
      windowsHide: true,
      // stdin 直接忽略（立即 EOF）：pi 在非 TTY 管道下可能等待 stdin，导致挂起
      stdio: ["ignore", "pipe", "pipe"],
      // 各模型的 API key 只经环境变量注入，不落在沙箱文件里
      env: { ...process.env, ...(this.opts.env ?? {}) },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, this.opts.timeoutMs);

    return new Promise<PiResult>((resolve) => {
      child.stdout.on("data", (d: Buffer) => {
        if (stdout.length < MAX_CAPTURE) stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8");
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, text: `无法启动 pi: ${err.message}`, durationMs: Date.now() - started });
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({
            ok: false,
            text: `pi 处理超时（>${Math.round(this.opts.timeoutMs / 1000)} 秒），已终止`,
            durationMs: Date.now() - started,
          });
          return;
        }
        const text = stdout.trim();
        if (code === 0 && text) {
          resolve({ ok: true, text, durationMs: Date.now() - started });
          return;
        }
        const tail = (stderr.trim() || text || `退出码 ${code}`).slice(-2000);
        resolve({ ok: false, text: `pi 执行失败: ${tail}`, durationMs: Date.now() - started });
      });
    });
  }
}

/** 结束整个进程树（Windows 下 pi 会再拉 bash 子进程）。 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
  }
}
