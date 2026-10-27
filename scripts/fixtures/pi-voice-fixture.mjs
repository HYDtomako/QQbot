/**
 * voice_send 桥接集成测试用的"模型"：读到 CASE_VOICE_* 就按真实工具的行为调用 /voice-send。
 * 只用于本地假 OneBot + 假 TTS，不连接任何真实服务。
 */
const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const entertainment = prompt.includes("[娱乐模式·");
const caseId = (prompt.match(/CASE_[A-Z_]+/g)?.at(-1)) ?? "CASE_NONE";

let out = "answer";
if (caseId.startsWith("CASE_VOICE")) {
  const endpoint = process.env.QQ_VOICE_ENDPOINT ?? "";
  const token = process.env.QQ_VOICE_TOKEN ?? "";
  let payload = { text: "今天下午只有高数和英语两节课", voice: "御姐" };
  if (caseId === "CASE_VOICE_BADVOICE") payload = { text: "用默认音色念一句", voice: "宇宙第一音色" };
  if (caseId === "CASE_VOICE_LONG") payload = { text: "长".repeat(260) };
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const value = await response.json();
    out = `RESULT ${typeof value.text === "string" ? value.text : "no-text"}`;
  } catch (err) {
    out = `RESULT endpoint-error ${err instanceof Error ? err.message : String(err)}`;
  }
}
console.log(entertainment ? JSON.stringify({ text: out, sticker: null }) : out);
