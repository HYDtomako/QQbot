import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// 合成子进程：只读任务描述和 SELFTEST_* 环境，不加载 pi/config/日志/记忆。
const args = process.argv.slice(2);
const spec = JSON.parse(args.at(-1));
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.toUpperCase().startsWith("QQ_KNOWLEDGE_") || key.startsWith("SELFTEST_")) env[key] = value;
}
const event = { id: spec.id, pid: process.pid, args, env, time: Date.now() };
const record = (type) => {
  if (process.env.SELFTEST_EVENT_FILE) {
    appendFileSync(process.env.SELFTEST_EVENT_FILE, JSON.stringify({ ...event, type, time: Date.now() }) + "\n");
  }
};
record("start");
if (spec.descendant) {
  spawn(process.execPath, [fileURLToPath(import.meta.url), JSON.stringify({ id: `${spec.id}-descendant`, waitMs: 60_000 })], {
    env: process.env, stdio: "ignore", windowsHide: true,
  });
}
if (spec.waitMs) await delay(spec.waitMs);
const output = spec.repeat
  ? spec.repeat.text.repeat(spec.repeat.count)
  : spec.output ?? JSON.stringify(event);
await new Promise((resolve, reject) => process.stdout.write(output, (err) => err ? reject(err) : resolve()));
if (spec.stderr || spec.stderrRepeat) {
  const text = spec.stderrRepeat ? spec.stderrRepeat.text.repeat(spec.stderrRepeat.count) : spec.stderr;
  await new Promise((resolve, reject) => process.stderr.write(text, (err) => err ? reject(err) : resolve()));
}
record("end");
process.exitCode = spec.exitCode ?? 0;
