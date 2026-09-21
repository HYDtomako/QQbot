/**
 * schedule-tools 扩展：自然语言课表查询。
 * 用户说"下下周三有什么课""25号要上啥"时，pi 把日期转成 YYYY-MM-DD 调用本工具。
 * 数据来源：桥接定期刷新的 schedule/cache.json（含当前周起 5 周课表）。
 */

interface ExtensionAPI {
  registerTool(tool: ToolRegistration): void;
}

interface ToolRegistration {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
}

import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readCache, answerDay, currentWeekOf } from "../../../schedule/zf.ts";
import { renderWeekImage } from "../../../schedule/image.ts";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(MODULE_DIR, "../../..");

const DATE_SCHEMA = {
  type: "object",
  properties: {
    date: { type: "string", description: "要查询的日期，格式 YYYY-MM-DD；不填表示今天" },
    week: { type: "boolean", description: "true 时返回该日期所在周的整周课表，并生成课表图片" },
  },
  required: [],
};

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

let periodTimes: Record<string, string> | undefined;

function getPeriodTimes(): Record<string, string> | undefined {
  if (periodTimes) return periodTimes;
  try {
    const cfg = JSON.parse(readFileSync(path.join(ROOT_DIR, "config.json"), "utf8"));
    periodTimes = cfg.jw?.periodTimes;
  } catch {
    /* 无配置则不显示开始时间 */
  }
  return periodTimes;
}

function midnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export default function scheduleToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "schedule_query",
    label: "Schedule Query",
    description: "查询院长的课表（按日期）。覆盖从今天起约 5 周内的课表。",
    promptSnippet: "schedule_query: look up the class schedule for a date",
    promptGuidelines: [
      "用户问某天有什么课/课表/安排时，把日期转成 YYYY-MM-DD 调用本工具；今天可不填 date。",
      "用户要整周课表（如\"下周课表\"\"看看第4周\"）时，传该周内任一天日期并设 week=true，会返回课表图片。",
      "课表是院长的个人作息，所有人都可以查询；但没有增删改课的能力。",
    ],
    parameters: DATE_SCHEMA,
    async execute(_id, params) {
      const cache = readCache();
      if (!cache || !cache.currentZs) return text("课表缓存还没有生成，请稍后再试。");

      let target: Date;
      const raw = String(params.date ?? "").trim();
      if (raw) {
        const m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (!m) return text("日期格式请用 YYYY-MM-DD。");
        target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        if (isNaN(target.getTime())) return text(`无效日期：${raw}`);
      } else {
        target = new Date();
      }

      const fetchMid = midnight(new Date(cache.fetchedAt));
      const targetMid = midnight(target);
      const daysDiff = Math.round((targetMid - fetchMid) / 86400000);
      const idxFetch = (new Date(fetchMid).getDay() - 1 + 7) % 7; // 拉取当天在周一=0 坐标系的位置
      const idx = idxFetch + daysDiff;
      const zs = cache.currentZs + Math.floor(idx / 7);
      const weekday = (((idx % 7) + 7) % 7) + 1;

      if (zs > cache.currentZs + 4) return text("太远啦：课表缓存只覆盖未来一个月左右。");
      if (zs < 1) return text("早于学期开始的课表没有记录。");

      const label = `${target.getMonth() + 1}月${target.getDate()}日`;

      // 整周视图：渲染图片并返回标记（桥接会以图片消息发送）
      if (params.week === true) {
        if (!cache.weeks[String(zs)]) return text(`第 ${zs} 周的课表没有缓存。`);
        try {
          const png = renderWeekImage(cache, zs, getPeriodTimes(), target.getDay());
          const imgPath = path.join(ROOT_DIR, "schedule", `week-${zs}.png`);
          writeFileSync(imgPath, png);
          return text(`已生成第 ${zs} 周课表图片。\n[[IMG:${imgPath}]]`);
        } catch (err) {
          return text(`课表图片生成失败：${err instanceof Error ? err.message : err}`);
        }
      }

      return text(answerDay(cache, weekday, zs, getPeriodTimes(), label));
    },
  });
}
