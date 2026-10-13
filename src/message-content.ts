import type { FileRef, ImageRef } from "./router.ts";

export interface MessageContent {
  text: string;
  contextText: string;
  images: ImageRef[];
  files: FileRef[];
  replyIds: string[];
  mentionedBot: boolean;
}

const EMOJI_MEANINGS: Record<string, string> = {
  "😂": "笑哭，觉得好笑或调侃", "🤣": "大笑或夸张地调侃", "😭": "大哭，也常用于感动或夸张玩笑",
  "🥲": "含泪微笑，可能欣慰或苦笑", "🥹": "含泪，可能感动或委屈", "🙃": "倒脸，可能无奈、反讽或玩笑",
  "🙂": "微笑，也可能客气或反讽", "😅": "冒汗笑，可能尴尬或松一口气", "😓": "冒汗，可能窘迫或压力",
  "😇": "天使笑，可能乖巧或装无辜", "😏": "斜笑，可能得意或调侃", "😒": "不悦或嫌弃",
  "🙄": "翻白眼，可能无语或不耐烦", "😐": "面无表情，可能平静或无语", "😑": "闭眼无语或疲惫",
  "🤔": "思考或怀疑", "🧐": "仔细观察或质疑", "🤨": "挑眉怀疑", "😳": "脸红、吃惊或尴尬",
  "😱": "惊吓或夸张震惊", "🤯": "震惊或信息量过大", "😤": "不服、生气或鼓劲", "😡": "生气",
  "🥺": "恳求、委屈或撒娇", "😎": "酷、得意或自信", "🤡": "小丑，常用于自嘲或调侃",
  "💀": "骷髅，也可能表示笑死或无语，并不必然指死亡", "👀": "关注、围观或期待", "🫠": "融化，可能尴尬、疲惫或无奈",
  "👍": "赞同或称赞，也可能反讽", "👎": "不赞同", "👌": "可以、明白或认可", "🙏": "感谢、请求或祈愿",
  "👏": "鼓掌、赞赏，也可能反讽", "🤝": "握手、合作或认同", "💪": "加油、力量", "🫡": "敬礼、收到或致意",
  "❤": "爱心、喜爱或支持", "💔": "心碎、失落或夸张玩笑", "🔥": "火热、精彩或热情", "🎉": "庆祝",
  "✅": "确认或完成", "❌": "否定或错误", "🐶": "狗，也可能作为玩笑或反话提示", "🐱": "猫，具体梗需结合语境",
};
const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });

/** 保留原字符及组合，只给有限数量的已知 emoji 补充非确定性释义。 */
export function describeEmoji(text: string): string {
  const meanings = new Map<string, string>();
  for (const { segment } of graphemes.segment(text)) {
    const key = segment.replace(/\uFE0F|[\u{1F3FB}-\u{1F3FF}]/gu, "");
    if (EMOJI_MEANINGS[key] && !meanings.has(key)) meanings.set(key, `${segment}：${EMOJI_MEANINGS[key]}`);
    if (meanings.size === 6) break;
  }
  return meanings.size ? `${text}\n[emoji 提示（含义随语境变化）：${[...meanings.values()].join("；")}]` : text;
}

function label(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n\t\[\]\u0000-\u001f]/g, " ").trim().slice(0, 80) : "";
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function pickFileName(data: Record<string, unknown> | undefined): string | undefined {
  for (const v of [data?.file_name, data?.name, data?.file]) {
    if (typeof v !== "string") continue;
    const name = v.trim().split(/[\\/]/).pop()!.trim();
    if (name) return name;
  }
  return undefined;
}

export function parseMessageContent(segments: unknown, selfId?: string): MessageContent {
  const result: MessageContent = { text: "", contextText: "", images: [], files: [], replyIds: [], mentionedBot: false };
  if (!Array.isArray(segments)) return result;
  for (const segment of segments) {
    if (!segment || typeof segment !== "object") continue;
    const data = segment.data && typeof segment.data === "object" ? segment.data as Record<string, unknown> : {};
    if (segment.type === "text") {
      const text = typeof data.text === "string" ? data.text : "";
      result.text += text;
      result.contextText += text;
    } else if (segment.type === "at") {
      if (selfId && String(data.qq ?? "") === selfId) result.mentionedBot = true;
    } else if (segment.type === "face") {
      const raw = data.raw && typeof data.raw === "object" ? data.raw as Record<string, unknown> : {};
      const name = label(raw.faceText) || label(data.text) || label(data.name) || label(data.faceText);
      const id = label(String(data.id ?? "未知"));
      const text = `[QQ表情：${name || `ID ${id}，含义未知`}]`;
      result.text += text;
      result.contextText += text;
    } else if (segment.type === "image" || segment.type === "mface") {
      const name = label(data.summary) || label(data.name) || label(data.text);
      const isSticker = segment.type === "mface" || Number(data.sub_type ?? data.subType) === 1 || /表情/.test(name);
      const image: ImageRef = {
        file: string(data.file), fileId: string(data.file_id), url: string(data.url),
        summary: name || undefined, isSticker,
      };
      if (image.file || image.fileId || image.url) {
        result.images.push(image);
        result.contextText += `[图片${result.images.length}]`;
        if (segment.type === "image" && name && !/^(?:图片|动画表情)$/.test(name)) result.contextText += `[平台附带名称：${name}]`;
      } else {
        result.contextText += "[图片未提供可下载引用]";
      }
      if (segment.type === "mface") {
        const text = `[商城表情：${name || "名称未知"}]`;
        result.text += text;
        result.contextText += text;
      }
    } else if (segment.type === "file") {
      const file = {
        fileId: string(data.file_id), name: pickFileName(data), url: string(data.url),
        size: Number(data.file_size ?? 0) || undefined,
      };
      result.files.push(file);
      result.contextText += `[文件：${label(file.name) || "未命名"}]`;
    } else if (segment.type === "reply") {
      if (data.id !== undefined && data.id !== null && String(data.id)) result.replyIds.push(String(data.id));
    } else if (segment.type === "forward") {
      result.contextText += "[聊天记录]";
    }
  }
  result.text = result.text.trim();
  result.contextText = result.contextText.trim();
  return result;
}
