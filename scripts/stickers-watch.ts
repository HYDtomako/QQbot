import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 表情包素材监听：常驻运行，stickers/ 里新增或删除图片时自动跑一遍清单同步。
 *
 * - 就是 npm run stickers:sync 的自动版（子进程调用同一脚本，输出原样透传）
 * - 清单是热读取的：同步写入后立即生效，机器人不用重启
 * - 替换同名图片不会改清单（运行时按文件重新读字节），但会触发一次同步提示清单已是最新
 * 用法：npm run stickers:watch
 */

const EXT_RE = /\.(?:png|jpe?g|gif)$/i; // 只盯图片，manifest.json 自身写入不触发
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(path.resolve(here, ".."), "stickers");
const syncScript = path.join(here, "stickers-sync.ts");

function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

let running = false;
let pending = false;
let timer: NodeJS.Timeout | null = null;

function runSync(reason: string): void {
  if (running) {
    pending = true; // 上一次还没跑完，记一笔，完了补跑
    return;
  }
  running = true;
  console.log(`[${stamp()}] ${reason}，同步清单…`);
  const child = spawn(process.execPath, [syncScript], { stdio: "inherit" });
  child.on("exit", (code) => {
    running = false;
    if (code !== 0) {
      console.error(`[${stamp()}] 同步失败（退出码 ${code}）：按上面的提示修好 manifest.json 后，下次变动会自动重试。`);
    }
    if (pending) {
      pending = false;
      runSync("有新的变化");
    }
  });
}

console.log(`[${stamp()}] 监听 ${dir}：新增/删除图片会自动补/查清单，Ctrl+C 退出。`);
runSync("启动时检查");

let watcher;
try {
  watcher = watch(dir, (event, filename) => {
    if (!filename || !EXT_RE.test(filename)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      runSync(`检测到 ${filename} 变动`);
    }, 500);
  });
} catch (err) {
  console.error(`监听失败：${(err as Error).message}`);
  process.exit(1);
}
watcher.on("error", (err) => {
  console.error(`监听中断：${err.message}`);
  process.exit(1);
});
