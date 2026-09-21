/**
 * 课表图片渲染：把一周课表画成表格 PNG（@napi-rs/canvas，中文用系统微软雅黑）。
 */
import { createCanvas } from "@napi-rs/canvas";
import type { ScheduleBundle } from "./zf.ts";

const ROWS = [
  { start: 1, label: "1-2节" },
  { start: 3, label: "3-4节" },
  { start: 5, label: "5-6节" },
  { start: 7, label: "7-8节" },
  { start: 9, label: "9-10节" },
];
const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const PALETTE = ["#FFE0B2", "#B2DFDB", "#C5CAE9", "#F8BBD0", "#D1C4E9", "#FFCCBC", "#B3E5FC", "#DCEDC8"];
const FONT = '"Microsoft YaHei", "SimHei", sans-serif';

function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function wrap(ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (ctx.measureText(cur + ch).width > maxW && cur) {
      lines.push(cur);
      cur = ch;
    } else cur += ch;
    if (lines.length >= 3) return lines.slice(0, 3);
  }
  if (cur) lines.push(cur);
  return lines;
}

export function renderWeekImage(
  bundle: ScheduleBundle,
  zs: number,
  periodTimes?: Record<string, string>,
  todayDow?: number,
): Buffer {
  const lessons = bundle.weeks[String(zs)] ?? [];
  const leftW = 120;
  const colW = 130;
  const titleH = 56;
  const topH = titleH + 48;
  const rowH = 130;
  const W = leftW + colW * 7 + 20;
  const H = topH + rowH * ROWS.length + 16;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "top";

  // 标题
  ctx.fillStyle = "#263238";
  ctx.font = `bold 30px ${FONT}`;
  ctx.fillText(`第 ${zs} 周课表`, 20, 13);

  // 表头：日期列 + 星期列
  const today = todayDow ?? new Date().getDay(); // 0=周日
  for (let d = 1; d <= 7; d++) {
    const x = leftW + (d - 1) * colW;
    const isToday = (today === 0 ? 7 : today) === d;
    ctx.fillStyle = isToday ? "#4FC3F7" : "#ECEFF1";
    ctx.fillRect(x, topH - 44, colW - 6, 40);
    ctx.fillStyle = isToday ? "#01579B" : "#37474F";
    ctx.font = `bold 22px ${FONT}`;
    ctx.fillText(DAYS[d - 1], x + (colW - 6 - ctx.measureText(DAYS[d - 1]).width) / 2, topH - 37);
  }

  // 行标签 + 单元格
  ROWS.forEach((row, ri) => {
    const y = topH + ri * rowH;
    ctx.fillStyle = "#ECEFF1";
    ctx.fillRect(14, y, leftW - 6, rowH - 8);
    ctx.fillStyle = "#37474F";
    ctx.font = `bold 18px ${FONT}`;
    ctx.fillText(row.label, 24, y + 10);
    const t1 = periodTimes?.[String(row.start)];
    const t2 = periodTimes?.[String(row.start + 1)]; // 下节开始时间（如 7-8 节行显示 16:45）
    if (t1) {
      ctx.font = `13px ${FONT}`;
      ctx.fillStyle = "#78909C";
      ctx.fillText(t2 ? `${t1}/${t2}` : t1, 20, y + 40);
    }
    for (let d = 1; d <= 7; d++) {
      const cell = lessons.filter((l) => l.xqj === d && l.jcStart >= row.start && l.jcStart <= row.start + 1);
      if (cell.length === 0) continue;
      const x = leftW + (d - 1) * colW;
      const first = cell[0];
      // 下节单节（如 8-8 节班会）只占下半格，位置即真实时间
      const half = cell.length === 1 && first.jcStart === row.start + 1;
      const cy = half ? y + rowH / 2 : y;
      const ch = (half ? rowH / 2 : rowH) - 8;
      ctx.fillStyle = colorFor(first.kcmc);
      ctx.fillRect(x, cy, colW - 6, ch);
      ctx.fillStyle = "#263238";
      const nameSize = half ? 14 : 16;
      ctx.font = `bold ${nameSize}px ${FONT}`;
      const maxLines = half ? 1 : 3;
      const nameLines = wrap(ctx, first.kcmc, colW - 16).slice(0, maxLines);
      nameLines.forEach((line, li) => ctx.fillText(line, x + 8, cy + 7 + li * (nameSize + 4)));
      let ty = cy + 7 + nameLines.length * (nameSize + 4) + 3;
      ctx.font = `12px ${FONT}`;
      const roomFull = ("@" + first.cdmc).replace(/\s+/g, "");
      const roomLines = wrap(ctx, roomFull, colW - 16).slice(0, half ? 1 : 2);
      roomLines.forEach((line) => {
        ctx.fillText(line, x + 8, ty);
        ty += 16;
      });
      if (first.xm && (!half || ty < cy + ch - 14)) {
        ctx.font = `12px ${FONT}`;
        ctx.fillText(first.xm, x + 8, cy + ch - 16);
      }
    }
  });

  return canvas.toBuffer("image/png");
}
