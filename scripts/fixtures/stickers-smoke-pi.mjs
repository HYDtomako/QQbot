// 冒烟测试用的假 pi：把收到的 prompt 记到 SMOKE_CALLS，按 prompt 里的标记返回协议 JSON。
// 标记用专属英文 token，避免和提示词正文里的中文词（如“选图”）碰撞。
const args = process.argv.slice(2);
const prompt = args[args.length - 1] ?? "";
if (process.env.SMOKE_CALLS) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.SMOKE_CALLS, JSON.stringify({ prompt }) + "\n");
}
let out = "咕嘎接一句";
if (prompt.includes("SMOKE_BAD")) out = '{"text":';
else if (prompt.includes("SMOKE_SILENCE")) out = '{"text":"","sticker":null}';
else if (prompt.includes("SMOKE_UNKNOWN")) out = '{"text":"安全文字","sticker":"nope"}';
else if (prompt.includes("SMOKE_MISSING")) out = '{"text":"回退吧","sticker":"bubble"}';
else if (prompt.includes("SMOKE_PICK")) out = '{"text":"配个图","sticker":"happy"}';
else if (prompt.includes("SMOKE_HELLO")) out = '{"text":"在呢在呢","sticker":null}';
console.log(out);
