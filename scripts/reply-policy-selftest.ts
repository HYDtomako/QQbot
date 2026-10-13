import assert from "node:assert/strict";
import {
  isInternalReply,
  normalReplyText,
  readInternalReply,
  recordedReplyText,
} from "../src/reply-policy.ts";

// node scripts/reply-policy-selftest.ts — 仅合成数据，不读配置/日志、不连接 QQ。
const fallback = "我在，有什么想聊的？";
const plainRequest = "今天怎么样？";
const internal = JSON.stringify({ text: "你好", sticker: "happy" });
const quotedText = '他说："你好"；字段 "sticker": "happy" 只是正文。\nC:\\tmp\\note\t结束';
const literalText = '{"text":"嵌套示例","sticker":null}';
const valid: Array<{ raw: string; text: string; sticker: string | null }> = [
  { raw: internal, text: "你好", sticker: "happy" },
  { raw: '{"text":"你好","sticker":null}', text: "你好", sticker: null },
  { raw: '{"sticker":"happy_01-x","text":"颠倒顺序"}', text: "颠倒顺序", sticker: "happy_01-x" },
  { raw: '{"text":"数字 ID","sticker":"0"}', text: "数字 ID", sticker: "0" },
  { raw: '{"text":"合法 ID 字符串","sticker":"null"}', text: "合法 ID 字符串", sticker: "null" },
  { raw: '{"text":"","sticker":null}', text: "", sticker: null },
  { raw: '{"text":"","sticker":"happy"}', text: "", sticker: "happy" },
  { raw: JSON.stringify({ text: " \t\r\n", sticker: null }), text: " \t\r\n", sticker: null },
  { raw: JSON.stringify({ text: "  保留正文空白\n", sticker: null }), text: "  保留正文空白\n", sticker: null },
  { raw: JSON.stringify({ text: quotedText, sticker: null }), text: quotedText, sticker: null },
  { raw: JSON.stringify({ text: literalText, sticker: null }), text: literalText, sticker: null },
  { raw: JSON.stringify({ text: "```json\n示例\n```", sticker: null }), text: "```json\n示例\n```", sticker: null },
  { raw: '  \n{\n  "text": "带空白",\n  "sticker": null\n}\t', text: "带空白", sticker: null },
  { raw: '{"te\\u0078t":"转义键名","sticker":"happy"}', text: "转义键名", sticker: "happy" },
  { raw: `\`\`\`json\n${internal}\n\`\`\``, text: "你好", sticker: "happy" },
  { raw: ` \n\`\`\`JSON \r\n${internal}\r\n  \`\`\`\n`, text: "你好", sticker: "happy" },
  { raw: `\`\`\`\n${internal}\n\`\`\``, text: "你好", sticker: "happy" },
  { raw: '\`\`\`json\n{"text":"","sticker":null}\n\`\`\`', text: "", sticker: null },
];

for (const { raw, text, sticker } of valid) {
  assert.equal(isInternalReply(raw), true, raw);
  assert.deepEqual(readInternalReply(raw), { text, sticker }, raw);
  assert.equal(normalReplyText(raw, plainRequest), text.trim() ? text : fallback, raw);
  assert.equal(recordedReplyText(raw), text.trim() ? text : "", raw);
  // 明确格式请求优先于空文本兜底，围栏和外部空白也必须逐字保留。
  assert.equal(normalReplyText(raw, "请返回 JSON 原文"), raw);
}

const unchanged = [
  "", "  \n", "普通文本", "这次不说了。", "JSON 是一种数据格式。",
  "null", "true", "42", '"字符串"', "[]", "{}",
  '{"text":"普通对象"}', '{"sticker":null}', '{"answer":"你好"}',
  '{"text":"你好","sticker":null,"extra":true}',
  '{"text":"你好","sticker":null,"__proto__":{}}',
  '{"text":"你好","Sticker":null}',
  '{"Text":"你好","sticker":null}',
  '{"text":"你好","sticker":null,"text":"重复字段"}',
  '{"text":"你好","sticker":null,"sticker":"happy"}',
  '{"text":"你好","sticker":null,"te\\u0078t":"重复字段"}',
  '{"text":{},"text":"覆盖错误类型","sticker":null}',
  `[${internal}]`, `{"reply":${internal}}`,
  "{text:'你好',sticker:null}", '{"text":"你好","sticker":null,}',
  '{"text":', '{"text":"未转义\n换行","sticker":null}',
  `回答如下：${internal}`, `${internal}\n以上是回答。`,
  `${internal}\n${internal}`, `${internal} // 注释`,
  `\`\`\`javascript\n${internal}\n\`\`\``,
  `\`\`\`json5\n${internal}\n\`\`\``,
  `\`\`\`json\n${internal}`,
  `\`\`\`json\n\`\`\`json\n${internal}\n\`\`\`\n\`\`\``,
  `\`\`\`json\n${internal}\n\`\`\`\n\`\`\`json\n${internal}\n\`\`\``,
  `解释\n\`\`\`json\n${internal}\n\`\`\``,
  `\`\`\`json\n${internal}\n\`\`\`\n解释`,
  ...[null, 1, true, [], {}].map((text) => JSON.stringify({ text, sticker: null })),
  ...["", "Happy", "happy face", " happy", "happy ", "happy\n", "happy\r", "happy\t", "开心", "../happy", "happy.jpg", "https://example.test/happy", 0, true, [], {}]
    .map((sticker) => JSON.stringify({ text: "你好", sticker })),
];
for (const raw of unchanged) {
  assert.equal(isInternalReply(raw), false, raw);
  assert.equal(readInternalReply(raw), null, raw);
  assert.equal(normalReplyText(raw, plainRequest), raw, raw);
  assert.equal(normalReplyText(raw, "给我一个代码示例"), raw, raw);
  assert.equal(recordedReplyText(raw), raw, raw);
}

const literalRequests = [
  "请返回 JSON 格式。", "请用 JSON", "只输出JSON，不要说明", "给我一个 JSON 对象示例",
  "用 JSON 格式回答这个问题", "用结构化数据回复", "请以协议格式返回",
  "原样输出下面这段内容", "请保留原文", "写一段 Python 代码",
  "给我一个 TypeScript 代码示例", "展示代码原文", "代码示例", "给出 HTTP 协议格式示例",
  "请返回 YAML 格式", "JSON", "JSON only", "Return JSON only.",
  "Please output structured data.", "Show a code example.",
  "Please keep the raw protocol response.", "Respond in JSON format.",
];
for (const request of literalRequests) {
  assert.equal(normalReplyText(internal, request), internal, request);
  const fenced = ` \n\`\`\`json\n${internal}\n\`\`\`\n`;
  assert.equal(normalReplyText(fenced, request), fenced, request);
}

const conversationalRequests = [
  "", plainRequest, "我今天在学 JSON，有点累。", "解释一下 JSON 的用途",
  "JSON 是什么？", "刚看了一天代码，好累。", "别发 JSON 了，聊聊吧。",
  "不要输出 JSON，正常说话。", "别给我JSON", "无需使用JSON格式，聊聊就好。",
  "I am learning JSON and feel tired.", "What is JSON?",
];
for (const request of conversationalRequests) {
  assert.equal(normalReplyText(internal, request), "你好", request);
}

// 历史转换只去最外层协议，不串联 normalReplyText，也不改写正文/用户内容。
assert.equal(recordedReplyText(internal), "你好");
assert.equal(recordedReplyText('{"text":"","sticker":"happy"}'), "");
assert.equal(recordedReplyText(JSON.stringify({ text: literalText, sticker: "happy" })), literalText);
assert.equal(recordedReplyText(JSON.stringify({ text: quotedText, sticker: "happy" })), quotedText);
assert.equal(recordedReplyText('  {"text":"业务 JSON","count":1}  '), '  {"text":"业务 JSON","count":1}  ');

console.log(`reply-policy-selftest: all passed (${valid.length} internal, ${unchanged.length} unchanged, ${literalRequests.length} literal requests, ${conversationalRequests.length} conversational requests)`);
