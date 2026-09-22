import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { OneBotClient } from "./onebot.ts";
import { pickFileName, type FileRef, type ImageRef, type TriggeredMessage } from "./router.ts";

/**
 * 消息附件（图片 / 文本文件）落地：从当前消息与"引用回复"的消息段里汇总附件，
 * 下载到沙箱目录后以 @路径 交给 pi。单独成模块是为了能脱离 bot 进程直接跑回归。
 */
export interface AttachmentCtx {
  client: OneBotClient;
  /** 附件落地目录（沙箱内，pi 可读） */
  dir: string;
  log: (...args: unknown[]) => void;
}

export interface Attachments {
  collect(trigger: TriggeredMessage): Promise<{ images: ImageRef[]; files: FileRef[] }>;
  materializeImages(images: ImageRef[]): Promise<string[]>;
  materializeFiles(files: FileRef[]): Promise<{ paths: string[]; rejected: string[] }>;
  cleanup(): void;
}

// ── 文字文件：只读 txt/md 类文本文件（非 coding agent，不接管代码/二进制文件）──
const TEXT_FILE_EXTS = new Set(["txt", "md", "markdown", "text", "log"]);
const MAX_TEXT_FILE_BYTES = 512 * 1024; // 超过 512KB 的文本文件拒绝，避免撑爆上下文

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

/** 内容是否像纯文本：UTF-8 可解码、无 NUL、控制字符极少。用于文件名彻底缺失时的兜底判断。 */
function looksLikeText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  const s = buf.toString("utf8");
  if (s.includes("\uFFFD")) return false;
  const bad = [...s].filter((ch) => ch < " " && ch !== "\n" && ch !== "\r" && ch !== "\t").length;
  return bad / Math.max(1, s.length) < 0.01;
}

export function createAttachments(ctx: AttachmentCtx): Attachments {
  const { client, dir, log } = ctx;
  mkdirSync(dir, { recursive: true });

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

  /** 下载并落地文字文件；返回可传给 pi 的路径与被拒文件说明。 */
  async function materializeFiles(files: FileRef[]): Promise<{ paths: string[]; rejected: string[] }> {
    const paths: string[] = [];
    const rejected: string[] = [];
    for (const f of files) {
      let name = (f.name ?? "").trim();
      const declared = extOf(name);
      // 段里已写明扩展名且不是文本格式 → 直接拒绝，不必白下载一次
      if (declared && !TEXT_FILE_EXTS.has(declared)) {
        rejected.push(`${name}（只支持 txt/md 文本文件）`);
        continue;
      }
      let buf: Buffer | null = null;
      if (f.fileId) {
        const r = await client.getFile(f.fileId);
        // 文件名缺失时（引用消息常见）用 NapCat 回带的 file_name 补全，再判类型
        if (!extOf(name) && r?.name) name = r.name;
        if (r?.base64) buf = Buffer.from(r.base64, "base64");
        else if (r?.path && existsSync(r.path)) buf = readFileSync(r.path);
        else if (r?.url) {
          try {
            const res = await fetch(r.url, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
            if (res.ok) buf = Buffer.from(await res.arrayBuffer());
          } catch {
            /* 落到失败分支 */
          }
        }
      }
      if (!buf && f.url) {
        try {
          const res = await fetch(f.url, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
          if (res.ok) buf = Buffer.from(await res.arrayBuffer());
        } catch {
          /* 落到失败分支 */
        }
      }
      const label = name || "未命名文件";
      if (!buf) {
        rejected.push(`${label}（下载失败）`);
        log(`[file] ${label} 获取失败（fileId=${f.fileId ?? "-"} url=${f.url ? "有" : "无"}）`);
        continue;
      }
      if (buf.length > MAX_TEXT_FILE_BYTES) {
        rejected.push(`${label}（过大 ${Math.round(buf.length / 1024)}KB，上限 512KB）`);
        continue;
      }
      let ext = extOf(name);
      if (ext && !TEXT_FILE_EXTS.has(ext)) {
        rejected.push(`${label}（只支持 txt/md 文本文件）`);
        continue;
      }
      if (!ext) {
        // 名字彻底不含扩展名：内容像文本才收，否则如实拒绝而不是把二进制塞给 pi
        if (!looksLikeText(buf)) {
          rejected.push(`${label}（识别不出是文本文件，只支持 txt/md）`);
          continue;
        }
        ext = "txt";
      }
      // 文件名可能很长（QQ 文件常是整段描述），截断但保留扩展名，pi 靠扩展名按文本附件读取
      const stem = name
        .replace(/\.[^.]+$/, "")
        .replace(/[\\/:*?"<>|\s]+/g, "_")
        .replace(/[._-]+$/, "")
        .slice(0, 60) || "文本文件";
      const p = path.join(dir, `${Date.now()}-${stem}.${ext}`);
      writeFileSync(p, buf);
      paths.push(p);
      log(`[file] ${label} 已落地（${Math.round(buf.length / 1024)}KB）`);
    }
    if (rejected.length) log(`[file] 未接收: ${rejected.join("；")}`);
    return { paths, rejected };
  }

  return { collect, materializeImages, materializeFiles, cleanup };
}
