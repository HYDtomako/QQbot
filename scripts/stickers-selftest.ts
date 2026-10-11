import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StickerLibrary, parseEntertainmentReply, stickerPrompt } from "../src/stickers.ts";

/**
 * 表情包回归（合成素材，不连接 QQ）：清单校验、冷却规则、字节保真、协议解析与回退。
 * 用法：node scripts/stickers-selftest.ts
 */
const root = mkdtempSync(path.join(os.tmpdir(), "stickers-selftest-"));
const dir = path.join(root, "stickers");
mkdirSync(dir, { recursive: true });

// 合成图片字节（库只按扩展名与大小校验，不需要真实可解码的图片）
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const GIF = Buffer.from("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b", "hex");

function writeManifest(entries: unknown, version: unknown = 1): void {
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version, stickers: entries }));
}

try {
  writeFileSync(path.join(dir, "happy.png"), PNG);
  writeFileSync(path.join(dir, "bubble.gif"), GIF);
  writeFileSync(path.join(root, "outside.png"), PNG);
  writeFileSync(path.join(dir, "big.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
  const lib = new StickerLibrary(dir);

  // ── 清单校验：非法条目只跳过该条 ──
  writeManifest([
    { id: "happy", file: "happy.png", name: "开心", description: "一起开心" },
    { id: "bubble", file: "bubble.gif", name: "冒泡", description: "轻松冒泡" },
    { id: "Happy", file: "happy.png", name: "大写 ID 不合法" },
    { id: "dup", file: "happy.png", name: "重复一次" },
    { id: "dup", file: "bubble.gif", name: "重复二次" },
    { id: "escape", file: "../outside.png", name: "越界路径" },
    { id: "missing", file: "missing.png", name: "文件不存在" },
    { id: "big", file: "big.png", name: "超过 8MiB" },
    { id: "txt", file: "note.txt", name: "非图片格式" },
  ]);
  assert.deepEqual(lib.available("g1").map((s) => s.id), ["happy", "bubble", "dup"]);
  let linked = false;
  try {
    symlinkSync(path.join(root, "outside.png"), path.join(dir, "link.png"));
    linked = true;
  } catch {
    console.log("SKIP 符号链接用例（当前环境不允许创建链接）");
  }
  if (linked) {
    writeManifest([{ id: "link", file: "link.png", name: "指向目录外" }]);
    assert.deepEqual(lib.available("g1").map((s) => s.id), []);
    console.log("PASS 安全性：指向素材目录外的符号链接被拒绝");
  }
  console.log("PASS 清单校验：非法 ID / 越界路径 / 缺文件 / 超 8MiB / 非图片格式被跳过；重复 ID 只保留第一条");

  // ── 清单热读取：改清单无需重启 ──
  writeManifest([{ id: "happy", file: "happy.png", name: "开心" }]);
  assert.deepEqual(lib.available("g2").map((s) => s.id), ["happy"]);
  writeManifest([
    { id: "happy", file: "happy.png", name: "开心" },
    { id: "bubble", file: "bubble.gif", name: "冒泡" },
  ]);
  assert.deepEqual(lib.available("g2").map((s) => s.id), ["happy", "bubble"]);
  console.log("PASS 热读取：清单每次接话重新读取，修改后立即生效");

  // ── 冷却：刚发过图 60 秒内不再发；同一 ID 10 分钟内不重复；按群隔离 ──
  const t0 = 1_000_000;
  lib.recordSent("g3", "happy", t0);
  assert.equal(lib.available("g3", t0 + 59_999).length, 0);
  assert.deepEqual(lib.available("g3", t0 + 60_001).map((s) => s.id), ["bubble"]);
  assert.deepEqual(lib.available("g3", t0 + 600_001).map((s) => s.id), ["happy", "bubble"]);
  assert.deepEqual(lib.available("g4", t0 + 1).map((s) => s.id), ["happy", "bubble"]);
  lib.recordSent("g4", null, t0);
  assert.deepEqual(lib.available("g4", t0 + 1).map((s) => s.id), ["happy", "bubble"]);
  console.log("PASS 冷却：60 秒内不连发图、同一 ID 10 分钟不重复、群与群之间互相隔离");

  // ── 字节保真与发送时兜底 ──
  const happy = lib.available("g5")[0];
  const seg = lib.image(happy);
  assert.equal(seg.type, "image");
  assert.equal(seg.data.file, "base64://" + PNG.toString("base64"));
  unlinkSync(path.join(dir, "happy.png"));
  assert.throws(() => lib.image(happy));
  writeFileSync(path.join(dir, "happy.png"), PNG);
  console.log("PASS 发送：原文件字节（base64）逐字节保真；文件被删时抛错交由调用方回退文字");

  // ── 坏清单/缺目录安全回退 ──
  writeFileSync(path.join(dir, "manifest.json"), "{不是 JSON");
  assert.deepEqual(lib.available("g6"), []);
  writeManifest([{ id: "happy", file: "happy.png", name: "开心" }], 2);
  assert.deepEqual(lib.available("g6"), []);
  assert.deepEqual(new StickerLibrary(path.join(root, "nonexistent")).available("g6"), []);
  writeManifest([{ id: "happy", file: "happy.png", name: "开心" }]);
  console.log("PASS 回退：坏 JSON / 版本不符 / 目录缺失都按“没有表情包”安全处理");

  // ── 回复协议解析 ──
  assert.deepEqual(parseEntertainmentReply('{"text":"咕嘎","sticker":"happy"}'), {
    valid: true,
    text: "咕嘎",
    sticker: "happy",
  });
  assert.deepEqual(parseEntertainmentReply('{"text":"","sticker":null}'), { valid: true, text: "", sticker: null });
  assert.deepEqual(parseEntertainmentReply('```json\n{"text":"你好","sticker":null}\n```'), {
    valid: true,
    text: "你好",
    sticker: null,
  });
  assert.equal(parseEntertainmentReply('{"text":').valid, false);
  assert.equal(parseEntertainmentReply('好的，{"text":"咕嘎","sticker":"happy"}').valid, false);
  assert.deepEqual(parseEntertainmentReply("随便聊两句"), { valid: true, text: "随便聊两句", sticker: null });
  assert.deepEqual(parseEntertainmentReply("这次不说了。"), { valid: true, text: "", sticker: null });
  assert.deepEqual(parseEntertainmentReply(""), { valid: true, text: "", sticker: null });
  console.log("PASS 协议：合法 JSON / 围栏 JSON / 纯文本兜底 / 沉默标记；坏 JSON 与带前缀 JSON 整条作废");

  // ── 提示词生成 ──
  const withChoices = stickerPrompt(lib.available("g7"));
  assert.match(withChoices, /happy（开心）/);
  assert.match(withChoices, /sticker 只能为上述 ID 或 null/);
  const withoutChoices = stickerPrompt([]);
  assert.match(withoutChoices, /本轮没有可用表情包/);
  assert.match(withoutChoices, /sticker 只能为 null/);
  console.log("PASS 提示词：模型只看到 id、名称与场景描述；无可用素材时明确提示只能用 null");

  console.log("stickers-selftest: all passed（合成素材，未连接 QQ）");
} finally {
  rmSync(root, { recursive: true, force: true });
}
