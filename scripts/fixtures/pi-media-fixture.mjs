import { appendFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const vision = prompt.includes("你是无会话的视觉摘要器");
appendFileSync(path.join(process.cwd(), "fixture-calls.jsonl"), JSON.stringify({
  vision, prompt, images: args.filter(a => a.startsWith("@")), session: args.includes("--session"),
  noTools: args.includes("--no-tools"), noExtensions: args.includes("--no-extensions"),
  model: args.includes("--model") ? args[args.indexOf("--model") + 1] : "",
}) + "\n");
if (vision) {
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log(JSON.stringify({ kind: "meme", visual: "合成猫趴在桌上", text: ["我不干了"], possibleTone: "疲惫或摆烂", uncertainty: "不确定梗的出处" }));
} else console.log(JSON.stringify({ text: "合成回复：收到", sticker: null }));
