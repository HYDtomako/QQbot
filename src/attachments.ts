import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { OneBotClient } from "./onebot.ts";
import { pickFileName, type FileRef, type ImageRef, type TriggeredMessage } from "./router.ts";
import {
  BINARY_EXTS,
  DOC_EXTS,
  FORMAT_HINT,
  TEXT_EXTS,
  convertDocument,
  sniffDocExt,
} from "./docparse.ts";

/**
 * 消息附件（图片 / 文件）落地：从当前消息与"引用回复"的消息段里汇总附件，
 * 下载到沙箱目录后以 @路径 交给 pi。单独成模块是为了能脱离 bot 进程直接跑回归。
 *
 * 文件分两类交给 pi：txt/md/csv 等纯文本原样落地；PDF/Word/Excel/PPT 先转成文本再落地
 * （pi 的附件只认图片与文本，二进制文档必须先取文）。
 */
export interface AttachmentCtx {
  client: OneBotClient;
  /** 附件落地目录（沙箱内，pi 可读） */
  dir: string;
  log: (...args: unknown[]) => void;
  /** 单文件文本上限（字符），超出截断 */
  maxTextChars?: number;
  /** 单条消息所有附件的文本总量上限（字符） */
  maxTotalChars?: number;
  /** pdftotext 可执行文件路径（默认自动查找） */
  pdftotext?: string;
}

/** 落地后的文件：path 给 pi，name 给用户看，note 说明做了什么转换 */
export interface MaterializedFile {
  path: string;
  name: string;
  note?: string;
}

export interface Attachments {
  collect(trigger: TriggeredMessage): Promise<{ images: ImageRef[]; files: FileRef[] }>;
  materializeImages(images: ImageRef[]): Promise<string[]>;
  materializeFiles(files: FileRef[]): Promise<{ files: MaterializedFile[]; rejected: string[] }>;
  cleanup(): void;
}

// ── 文件：纯文本原样收，文档类转成文本收（非 coding agent，不接管代码/压缩包/音视频）──
const SUPPORTED_EXTS = new Set([...TEXT_EXTS, ...DOC_EXTS]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 纯文本超过 2MB 直接拒，避免把巨型文件读进内存
const MAX_DOC_BYTES = 20 * 1024 * 1024; // 文档（pdf/office）下载上限
const MAX_FILES = 5; // 单条消息最多处理几个文件
const DEFAULT_MAX_TEXT_CHARS = 30_000; // 单文件文本上限，超出截断（对话上下文成本闸门）
const DEFAULT_MAX_TOTAL_CHARS = 60_000; // 单条消息所有附件的文本总量上限

/** 按文件头识别真实类型，NapCat 缓存里的图片常无扩展名。 */
function sniffExt(buf: Buffer): string {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "GIF8") return "gif";
  if (buf.length >= 12 && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "bmp";
  return "png";
}

/** 取末尾扩展名（小写）。只有形如 "xxx.md" 的结尾才算扩展名，避免把 "报告 v1.2" 当成后缀。 */
function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

/** 不支持时的拒绝理由（旧版 Office 单独提示，便于对方换格式重发）。 */
function rejectHint(ext: string): string {
  if (ext === "doc" || ext === "xls" || ext === "ppt" || ext === "wps" || ext === "et" || ext === "dps") {
    return "这种旧版 Office 格式读不了，请另存为 docx/xlsx/pptx 或 PDF 再发";
  }
  return BINARY_EXTS.has(ext) ? "这种二进制格式读不了" : `只支持 ${FORMAT_HINT}`;
}

export function createAttachments(ctx: AttachmentCtx): Attachments {
  const { client, dir, log } = ctx;
  mkdirSync(dir, { recursive: true });

  const maxTextChars = ctx.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const maxTotalChars = ctx.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const convOpts = { maxChars: maxTextChars, workDir: dir, pdftotext: ctx.pdftotext };

  /** 清理 1 小时前的旧附件（图片/文件临时副本）。定时执行，不依赖新附件到达。 */
  function cleanup(): void {
    try {
      const cutoff = Date.now() - 3600_000;
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f);
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      }
    } catch {
      /* ignore */
    }
  }

  /** 三级兜底取图：本地路径 → NapCat get_image → CDN 下载；返回落地后的沙箱路径。 */
  async function materializeImages(images: ImageRef[]): Promise<string[]> {
    const out: string[] = [];
    for (const [i, img] of images.entries()) {
      const save = (buf: Buffer): string => {
        const p = path.join(dir, `img-${Date.now()}-${i}.${sniffExt(buf)}`);
        writeFileSync(p, buf);
        return p;
      };
      let got: string | null = null;
      // 1) 直接本地路径（file 字段可能是绝对路径或 file:// URI）
      for (const c of [img.file].filter(Boolean) as string[]) {
        const p = c.startsWith("file://") ? c.slice(7) : c;
        try {
          if (existsSync(p) && statSync(p).isFile()) {
            got = save(readFileSync(p));
            break;
          }
        } catch {
          /* 继续尝试下一级 */
        }
      }
      // 2) NapCat get_image（file 或 file_id）
      if (!got && (img.file || img.fileId)) {
        const r = await client.getImage(img.file ?? img.fileId!);
        if (r?.base64) got = save(Buffer.from(r.base64, "base64"));
        else if (r?.path && existsSync(r.path)) got = save(readFileSync(r.path));
      }
      // 3) CDN 下载（腾讯域名，国内可直连）
      if (!got && img.url) {
        try {
          const res = await fetch(img.url, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > 0 && buf.length <= 8 * 1024 * 1024) got = save(buf);
          }
        } catch {
          /* 落到失败分支 */
        }
      }
      if (got) out.push(got);
      else log(`[image] 第 ${i + 1} 张图片获取失败（file=${img.file ?? "-"} fileId=${img.fileId ?? "-"} url=${img.url ? "有" : "无"}）`);
    }
    cleanup();
    return out;
  }

  /** 汇总附件：当前消息的图片/文件 + 引用消息里的图片/文件。 */
  async function collect(trigger: TriggeredMessage): Promise<{ images: ImageRef[]; files: FileRef[] }> {
    const images: ImageRef[] = [...(trigger.images ?? [])];
    const files: FileRef[] = [...(trigger.files ?? [])];
    for (const rid of trigger.replyIds ?? []) {
      const msg = await client.getMsg(rid);
      const segs = Array.isArray(msg?.message)
        ? (msg.message as Array<{ type: string; data?: Record<string, unknown> }>)
        : [];
      for (const s of segs) {
        if (s.type === "image") {
          images.push({
            file: typeof s.data?.file === "string" ? s.data.file : undefined,
            fileId: typeof s.data?.file_id === "string" ? s.data.file_id : undefined,
            url: typeof s.data?.url === "string" ? s.data.url : undefined,
          });
        } else if (s.type === "file") {
          files.push({
            fileId: typeof s.data?.file_id === "string" ? s.data.file_id : undefined,
            name: pickFileName(s.data),
            url: typeof s.data?.url === "string" ? s.data.url : undefined,
          });
        }
      }
      if (segs.length) {
        log(
          `[msg] 引用消息 ${rid}：${segs.filter((s) => s.type === "image").length} 图 / ${segs.filter((s) => s.type === "file").length} 文件`,
        );
      }
    }
    return { images, files };
  }

  /** 下载文件内容：NapCat get_file（base64/本地路径/直链）→ 消息段直链。回带 NapCat 里的文件名。 */
  async function downloadFile(f: FileRef): Promise<{ buf: Buffer; name?: string } | null> {
    if (f.fileId) {
      const r = await client.getFile(f.fileId);
      const name = r?.name?.trim() || undefined;
      if (r?.base64) return { buf: Buffer.from(r.base64, "base64"), name };
      if (r?.path && existsSync(r.path)) return { buf: readFileSync(r.path), name };
      if (r?.url) {
        try {
          const res = await fetch(r.url, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
          if (res.ok) return { buf: Buffer.from(await res.arrayBuffer()), name };
        } catch {
          /* 落到下一级 */
        }
      }
    }
    if (f.url) {
      try {
        const res = await fetch(f.url, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
        if (res.ok) return { buf: Buffer.from(await res.arrayBuffer()) };
      } catch {
        /* 落到失败分支 */
      }
    }
    return null;
  }

  /** 下载文件并转成文本落地；返回可传给 pi 的路径与被拒说明。 */
  async function materializeFiles(files: FileRef[]): Promise<{ files: MaterializedFile[]; rejected: string[] }> {
    const out: MaterializedFile[] = [];
    const rejected: string[] = [];
    let budget = maxTotalChars;
    for (const [i, f] of files.entries()) {
      let name = (f.name ?? "").trim();
      let declared = extOf(name);
      // 段里已写明扩展名且不支持 → 直接拒绝，不必白下载一次
      if (declared && !SUPPORTED_EXTS.has(declared)) {
        rejected.push(`${name}（${rejectHint(declared)}）`);
        continue;
      }
      if (i >= MAX_FILES) {
        rejected.push(`${name || "未命名文件"}（一次最多处理 ${MAX_FILES} 个文件）`);
        continue;
      }
      if (budget <= 0) {
        rejected.push(`${name || "未命名文件"}（本条消息附件内容已达上限，请分开发送）`);
        continue;
      }

      const got = await downloadFile(f);
      // 文件名缺失时（引用消息常见）用 NapCat 回带的 file_name 补全，再判类型
      if (got && !declared && got.name) {
        name = got.name;
        declared = extOf(name);
      }
      const label = name || "未命名文件";
      if (!got) {
        rejected.push(`${label}（下载失败）`);
        log(`[file] ${label} 获取失败（fileId=${f.fileId ?? "-"} url=${f.url ? "有" : "无"}）`);
        continue;
      }
      const { buf } = got;
      // 仍无扩展名：按内容嗅探（PDF/Office/网页），未知格式留给 convertDocument 兜底判文本
      const ext = declared || sniffDocExt(buf) || "";
      const limit = DOC_EXTS.has(ext) ? MAX_DOC_BYTES : MAX_TEXT_BYTES;
      if (buf.length > limit) {
        rejected.push(`${label}（过大 ${Math.round(buf.length / 1024)}KB，上限 ${Math.round(limit / 1024)}KB）`);
        continue;
      }

      const conv = await convertDocument(buf, ext, { ...convOpts, maxChars: Math.min(maxTextChars, budget) });
      if (!conv.ok) {
        rejected.push(`${label}（${conv.reason}）`);
        log(`[file] ${label} 未接收：${conv.reason}`);
        continue;
      }
      budget -= conv.text.length;
      // 展示名：没有扩展名的补一个，让提示词里能看出文件类型
      const displayName = extOf(name) ? label : `${label}.${ext || "txt"}`;
      // 文件名可能很长（QQ 文件常是整段描述），截断；转换后的文本统一落 .md，pi 按结构化文本内联
      const stem = (name.replace(/\.[^.]+$/, "") || "文件")
        .replace(/[\\/:*?"<>|\s]+/g, "_")
        .replace(/[._-]+$/, "")
        .slice(0, 60) || "文件";
      const p = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${stem}.md`);
      writeFileSync(p, conv.text, "utf8");
      out.push({ path: p, name: displayName, note: conv.note || undefined });
      log(`[file] ${label} 已落地（${Math.round(buf.length / 1024)}KB → 文本 ${conv.text.length} 字）${conv.note ? `｜${conv.note}` : ""}`);
    }
    if (rejected.length) log(`[file] 未接收: ${rejected.join("；")}`);
    return { files: out, rejected };
  }

  return { collect, materializeImages, materializeFiles, cleanup };
}
