import assert from "node:assert/strict";
import { buildCompactPrompt, compactPaReply, needsPaCleanup, PA_COMPACT_THRESHOLD, sanitizeCompact } from "../src/pa-format.ts";

// 用法：node scripts/pa-format-selftest.ts。全部离网：整理模型用假的 runModel 注入。

// ── needsPaCleanup：只有过长或带 Markdown 结构的回复才整理 ──
const short = "今天没有课，安心休息。";
assert.equal(needsPaCleanup(short), false);
assert.equal(needsPaCleanup(""), false);
assert.equal(needsPaCleanup("x".repeat(PA_COMPACT_THRESHOLD + 1)), true);
assert.equal(needsPaCleanup("步骤：\n```json\n{}\n```"), true);
assert.equal(needsPaCleanup("| 项 | 值 |\n| --- | --- |"), true);
assert.equal(needsPaCleanup("## 小标题\n内容"), true);
console.log("PASS needsPaCleanup: only long or structured replies get compacted");

// ── buildCompactPrompt：任务约束齐全，原文完整带入 ──
const longReport = [
  "检查完了，报告如下。",
  "",
  "1. stickers/manifest.json 里 file 字段写的是不存在的英文名，6 张全被过滤。",
  "2. 运行中的 bot 是旧代码，进程 PID 66052，启动时间 2026/10/11 14:08:25，必须重启。",
  "",
  "备份在 workspace/backup/stickers-manifest.json.20261012-014937.bak。",
].join("\n");
const prompt = buildCompactPrompt(longReport, 400, "private:10001");
assert.ok(prompt.includes(longReport), "prompt must embed the full report");
assert.ok(prompt.includes("400 字"));
assert.ok(prompt.includes("QQ 私聊"));
assert.match(prompt, /PID/);
assert.match(prompt, /不要任何前言/);
assert.ok(buildCompactPrompt(longReport, 400, "group:123").includes("QQ 群 123"));
console.log("PASS buildCompactPrompt: constraints and context are explicit");

// ── sanitizeCompact：剥围栏/前言、超长按句截断、不空吐 ──
assert.equal(sanitizeCompact("```\n好的：结论是没课。\n```", 400), "结论是没课。");
assert.equal(sanitizeCompact("以下是答复：没课。", 400), "没课。");
assert.equal(sanitizeCompact("方法一。方法二。方法三。方法四。", 10), "方法一。方法二。");
assert.equal(sanitizeCompact("方法一。方法二。方法三。方法四。", 6), "方法一。");
console.log("PASS sanitizeCompact: fences/prefixes dropped, long output trimmed at sentence end");

// ── compactPaReply：成功走整理；模型失败/空输出返回空串由调用方回退 ──
let seenPrompt = "";
const compacted = await compactPaReply(longReport, async (p) => {
  seenPrompt = p;
  return "结论：表情包问题已修好，但线上跑的还是旧代码，需要重启 bot 才生效。要现在重启吗？";
}, { via: "private:10001" });
assert.equal(compacted, "结论：表情包问题已修好，但线上跑的还是旧代码，需要重启 bot 才生效。要现在重启吗？");
assert.ok(seenPrompt.includes(longReport));
assert.equal(await compactPaReply(longReport, async () => ""), "", "empty model output must fall back");
assert.equal(await compactPaReply(longReport, async () => { throw new Error("model down"); }), "", "model error must fall back");
console.log("PASS compactPaReply: compacts on success, returns empty for caller fallback on failure");

console.log("pa-format-selftest: all passed");
