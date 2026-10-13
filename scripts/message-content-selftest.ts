import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseMessageContent, describeEmoji } from "../src/message-content.ts";
import { matchMessage } from "../src/router.ts";
import { createAttachments } from "../src/attachments.ts";
import type { OneBotClient } from "../src/onebot.ts";
import { parseChatLog, renderChatMessage, readRecentChat, chatDate } from "../src/group-chat.ts";

const text = "真的😂😂 🙃 👍🏽 👨‍👩‍👧‍👦 🇨🇳 1️⃣ 🫨";
const described = describeEmoji(text);
assert.ok(described.startsWith(text));
assert.match(described, /笑哭|反讽/);
assert.equal(described.split("😂：").length, 2);
assert.match(described, /👍🏽：/);
assert.equal(describeEmoji("👨‍👩‍👧‍👦 🇨🇳 1️⃣ 🫨"), "👨‍👩‍👧‍👦 🇨🇳 1️⃣ 🫨");
assert.equal(describeEmoji("模型状态"), "模型状态");
console.log("PASS emoji 原字符、重复、肤色和组合保留；未知不猜测，普通命令不改写");

const face = { type: "face", data: { id: 480, raw: { faceText: "/散味儿" } } };
const unknown = { type: "face", data: { id: 99999 } };
const parsed = parseMessageContent([face, unknown, { type: "mface", data: { summary: "摆烂", url: "https://i.gtimg.cn/a.gif" } }]);
assert.match(parsed.text, /QQ表情：\/散味儿/);
assert.match(parsed.text, /ID 99999，含义未知/);
assert.match(parsed.contextText, /\[图片1\]/);
assert.equal(parsed.images[0].isSticker, true);
assert.equal(parsed.images[0].summary, "摆烂");
assert.equal(parseMessageContent(null).text, "");
assert.equal(parseMessageContent([null, {}, { type: "text" }]).text, "");
console.log("PASS face 保留名称/ID、mface 保留名称并取图、坏消息段安全处理");

const event = { post_type: "message", message_type: "group", user_id: "11111", group_id: "33333", message: [face] };
assert.equal(matchMessage(event, "22222", new Set(["11111"]), ["qb"]), null);
const addressed = { ...event, message: [{ type: "at", data: { qq: "22222" } }, face] };
assert.match(matchMessage(addressed, "22222", new Set(), ["qb"])!.text, /散味儿/);
assert.equal(matchMessage({ ...addressed, user_id: "22222" }, "22222", new Set(), ["qb"]), null);
assert.ok(matchMessage({ ...event, message_type: "private" }, "22222", new Set(["11111"]), ["qb"]));
assert.equal(matchMessage({ ...event, message_type: "private" }, "22222", new Set(), ["qb"]), null);
const command = matchMessage({ ...event, message: [{ type: "text", data: { text: "@qb 模型状态" } }] }, "22222", new Set(), ["qb"]);
assert.equal(command!.text, "模型状态");
console.log("PASS 路由维持群 @、私聊白名单、自消息忽略和命令识别");

const dir = mkdtempSync(path.join(tmpdir(), "qq-message-content-"));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT6UAAAAASUVORK5CYII=", "base64");
try {
  const source = path.join(dir, "synthetic.png");
  writeFileSync(source, png);
  writeFileSync(path.join(dir, "not-image.txt"), "not an image");
  const client = {
    getImage: async () => null,
    getMsg: async (id: string) => ({ group_id: id === "other" ? "99999" : "33333", sender: { user_id: "11111", nickname: "甲" },
      message: [face, { type: "text", data: { text: "😂" } }, { type: "mface", data: { file: source, summary: "合成表情" } }],
    }),
  } as unknown as OneBotClient;
  const attachments = createAttachments({ client, dir: path.join(dir, "attachments"), log: () => {} });
  const quote = await attachments.collect({ kind: "group", groupId: "33333", userId: "11111", text: "", replyIds: ["quote", "quote", "other"] });
  assert.equal(quote.images.length, 1);
  assert.match(quote.quotedText.join(""), /散味儿.*😂/s);
  assert.doesNotMatch(quote.quotedText.join(""), /other/);
  assert.equal((await attachments.materializeImages([{ file: pathToFileURL(source).href }])).length, 1);
  assert.equal((await attachments.materializeImages([{ file: path.join(dir, "not-image.txt") }])).length, 0);
  assert.equal((await attachments.materializeImages(Array(5).fill({ file: source }))).length, 3);
  const parallel = await Promise.all([attachments.materializeImages([{ file: source }]), attachments.materializeImages([{ file: source }])]);
  assert.notEqual(parallel[0][0], parallel[1][0]);
  console.log("PASS 引用保留表情/emoji/原图，跨群引用隔离，真实格式与数量限制，文件名不冲突");

  const rows = [
    { t: "2026-10-13T00:00:00Z", u: "a", n: "甲", m: "[图片1]", id: "1", mediaCount: 1 },
    { t: "2026-10-13T00:00:01Z", u: "b", n: "乙", m: "[图片1]", id: "2", mediaCount: 1 },
    { kind: "media", id: "2", descriptions: ["蓝色圆形"] },
    { kind: "media", id: "1", descriptions: ["红色方形"] },
  ];
  const log = rows.map(row => JSON.stringify(row)).join("\n");
  const entries = parseChatLog(log + "\nnot json");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].u, "a");
  assert.match(renderChatMessage(entries[0]), /红色方形/);
  assert.doesNotMatch(renderChatMessage(entries[0]), /蓝色圆形/);
  const recalled = parseChatLog(log + '\n{"kind":"recall","id":"1"}\n' + JSON.stringify(rows[3]));
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].id, "2");
  assert.match(renderChatMessage({ t: "", u: "a", n: "a", m: "[图片1]" }), /尚未识别/);
  const now = new Date(2026, 9, 14, 0, 0, 2);
  const yesterday = new Date(2026, 9, 13, 23, 59, 59);
  writeFileSync(path.join(dir, `33333-${chatDate(yesterday)}.jsonl`), log);
  writeFileSync(path.join(dir, `33333-${chatDate(now)}.jsonl`), '{"kind":"recall","id":"1"}\n');
  assert.equal(readRecentChat(dir, "33333", 20, now).length, 1);
  assert.equal(readRecentChat(dir, "../33333", 20, now).length, 0);
  console.log("PASS 识别补充不改变发言顺序、不串发送者，撤回抑制迟到结果，跨午夜合并");
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("message-content-selftest: 5/5 passed（合成数据）");
