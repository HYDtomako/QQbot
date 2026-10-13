import { createCanvas } from "@napi-rs/canvas";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PiRunner } from "../src/runner.ts";
import { createAttachments } from "../src/attachments.ts";
import type { OneBotClient } from "../src/onebot.ts";
import { MediaContext } from "../src/media-context.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8"));
let alias = process.argv[2] || config.pi.defaultModel;
if (!process.argv[2]) {
  try { alias = JSON.parse(readFileSync(path.join(root, ".model-state.json"), "utf8")).alias || alias; } catch { /* 使用默认模型 */ }
}
const model = config.pi.models?.[alias] || alias;
const dir = mkdtempSync(path.join(tmpdir(), "qq-vision-probe-"));
const runner = new PiRunner({
  command: config.pi.command, args: config.pi.args, thinking: "", cwd: path.join(root, "sandbox"),
  maxConcurrent: 1, timeoutMs: 60_000,
  env: {
    ...(config.pi.aliyunKey ? { ALIYUN_MAA_API_KEY: config.pi.aliyunKey } : {}),
    ...(config.pi.aliyunBaseUrl ? { ALIYUN_MAA_BASE_URL: config.pi.aliyunBaseUrl } : {}),
  },
});
try {
  const canvas = createCanvas(400, 240);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 400, 240);
  ctx.fillStyle = "#ed1717";
  ctx.fillRect(40, 70, 100, 100);
  ctx.fillStyle = "#162cff";
  ctx.beginPath(); ctx.arc(280, 120, 55, 0, Math.PI * 2); ctx.fill();
  const image = path.join(dir, "synthetic.png");
  writeFileSync(image, canvas.toBuffer("image/png"));
  console.log(`视觉探针：${model}，仅发送本地生成的几何图，不读取或发送群聊图片。`);
  const result = await runner.run(
    "这是视觉能力检测，不是群聊回复。请查看附图，仅输出左右两个主要彩色图形的颜色和形状。若无法看到附件，明确回答无法查看，不要猜测。",
    { mode: "none", model, imagePaths: [image], timeoutMs: 60_000 },
  );
  if (!result.ok) {
    console.log("FAIL：视觉调用失败，未验证视觉能力。");
    process.exitCode = 1;
  } else {
    const passed = /红/.test(result.text) && /蓝/.test(result.text) && /(?:正方|方形|方块|矩形)/.test(result.text) && /圆/.test(result.text);
    console.log(`${passed ? "PASS" : "FAIL"}：${result.text.slice(0, 600)}`);
    if (!passed) process.exitCode = 1;
    if (passed) {
      const attachments = createAttachments({ client: { getImage: async () => null } as unknown as OneBotClient, dir: path.join(dir, "attachments"), log: () => {} });
      const media = new MediaContext({ attachments, runner, model: () => model, log: () => {}, limits: { deadlineMs: 60_000 } });
      try {
        const descriptions = await media.observe({ groupId: "synthetic", userId: "synthetic", messageId: "probe", receivedAtMs: Date.now(), images: [{ file: image }] });
        const summary = descriptions.join(" ");
        const pipelinePassed = /视觉摘要/.test(summary) && /红/.test(summary) && /蓝/.test(summary) && !/未识别/.test(summary);
        console.log(`${pipelinePassed ? "PASS" : "FAIL"}：后台识别完整链路（下载落地 → 图片附件 → JSON 摘要 → 上下文关联）`);
        if (!pipelinePassed) process.exitCode = 1;
      } finally { await media.close(); }
    }
  }
} finally {
  await runner.close();
  rmSync(dir, { recursive: true, force: true });
}
