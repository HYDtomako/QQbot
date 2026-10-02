/**
 * 链接正文预取：QQ 消息里出现链接时，在交给 pi 之前先尝试把正文取回来，
 * 拼进 prompt，避免 pi 的 web_read 在 SPA（正文靠前端脚本渲染）站点上抓空。
 *
 * 目前只处理已知站点（kirigaya.cn 的博客文章）。其它链接返回 null，仍交给 pi 的 web_read。
 * 新增站点时在 RESOLVERS 里加一条即可：输入 URL，输出正文 Markdown 或 null。
 */
import zlib from "node:zlib";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

// 预取正文的最大字符数，避免把 prompt 撑爆
const MAX_CHARS = 24_000;
// 单个链接预取的超时
const TIMEOUT_MS = 15_000;

type Resolver = (u: URL) => Promise<string | null>;

/** kirigaya.cn 博客：SPA，正文由 /api/blog/fetch-blog-by-seq 返回 base64(gzip) 的 Markdown */
async function resolveKirigaya(u: URL): Promise<string | null> {
  if (!/(^|\.)kirigaya\.cn$/i.test(u.hostname)) return null;
  if (!u.pathname.startsWith("/blog/article")) return null;
  const seq = u.searchParams.get("seq");
  if (!seq || !/^\d+$/.test(seq)) return null;

  const res = await fetch(
    `https://kirigaya.cn/api/blog/fetch-blog-by-seq?seq=${seq}`,
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!res.ok) return null;
  const j = (await res.json()) as { data?: { text?: unknown } };
  const b64 = j?.data?.text;
  if (typeof b64 !== "string" || !b64) return null;

  const buf = Buffer.from(b64, "base64");
  let md: Buffer;
  try {
    md = zlib.gunzipSync(buf);
  } catch {
    md = zlib.inflateSync(buf);
  }
  const text = md.toString("utf8").trim();
  return text ? text.slice(0, MAX_CHARS) : null;
}

const RESOLVERS: Resolver[] = [resolveKirigaya];

/** 从一段文本里抽出所有 http(s) 链接（去重、去掉尾部常见标点） */
export function extractLinks(text: string): string[] {
  const out = new Set<string>();
  const re = /https?:\/\/[^\s<>"'`）】)\]]+/g;
  for (const m of text.match(re) ?? []) {
    out.add(m.replace(/[.,;:!?。，；：！？]+$/, ""));
  }
  return [...out];
}

/** 尝试预取一段文本里所有链接的正文；返回可直接拼进 prompt 的文本块（无内容则为空串） */
export async function prefetchLinks(text: string): Promise<string> {
  const urls = extractLinks(text);
  if (!urls.length) return "";
  const blocks: string[] = [];
  await Promise.all(
    urls.map(async (raw) => {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        return;
      }
      for (const r of RESOLVERS) {
        try {
          const body = await r(u);
          if (body) {
            blocks.push(`【链接正文（已预读取，优先据此回答；来源 ${raw}）】\n${body}`);
            return;
          }
        } catch {
          /* 单个解析器失败继续试下一个 */
        }
      }
    }),
  );
  return blocks.length ? "\n\n" + blocks.join("\n\n") : "";
}
