/**
 * task_manage 的桥接侧实现。
 *
 * 谁能改定时任务只看本轮回环凭据绑上的 QQ。
 * 群发目标的群号是业务参数；私聊目标固定写成院长 QQ，不接受模型另报的号码。
 */

import type { ScheduledTask } from "./tasks.ts";

export interface TaskManageRequest {
  /** 桥接从 OneBot 事件绑定的提问者，不是模型参数。 */
  asker: string;
  owner: string;
  op: unknown;
  name?: unknown;
  time?: unknown;
  at?: unknown;
  target?: unknown;
  groupId?: unknown;
  days?: unknown;
  prompt?: unknown;
  now?: Date;
}

export interface TaskManageResult {
  ok: boolean;
  text: string;
  /** 有值时桥接应替换 config.json 的 tasks。拒绝和 list 绝不带这个字段。 */
  next?: ScheduledTask[];
}

function deny(text: string): TaskManageResult {
  return { ok: false, text };
}

function saved(tasks: ScheduledTask[]): TaskManageResult {
  return { ok: true, text: `已完成。当前共 ${tasks.length} 个定时任务。`, next: tasks };
}

export function runTaskManage(input: TaskManageRequest, tasks: ScheduledTask[]): TaskManageResult {
  const asker = String(input.asker ?? "").trim();
  const owner = String(input.owner ?? "").trim();
  if (asker !== owner) return deny("只有院长可以管理定时任务。");
  if (!owner) return deny("配置异常（未设置院长 QQ）。");

  const op = String(input.op ?? "").trim();
  const current = Array.isArray(tasks) ? tasks : [];

  switch (op) {
    case "list": {
      if (current.length === 0) return { ok: true, text: "还没有定时任务。" };
      const lines = current.map((task) => {
        const when = task.at
          ? `一次性 ${task.at}`
          : `${task.days?.length ? "每周" + task.days.map((day) => "一二三四五六日"[day - 1]).join("、") : "每天"} ${task.time}`;
        return `${task.enabled === false ? "[停用]" : "[启用]"} ${task.name} | ${when} | ${task.target.type === "group" ? "群" + task.target.id : "私聊"}`;
      });
      return { ok: true, text: `共 ${current.length} 个定时任务：\n${lines.join("\n")}` };
    }
    case "add": {
      const name = String(input.name ?? "").trim();
      const time = String(input.time ?? "").trim();
      const at = String(input.at ?? "").trim();
      const targetStr = String(input.target ?? "").trim();
      const prompt = String(input.prompt ?? "").trim();
      if (!name || name.length > 20) return deny("任务名称缺失或过长（≤20 字）。");
      if (current.some((task) => task.name === name)) return deny(`已有同名任务「${name}」。`);
      if (current.length >= 20) return deny("任务数量已达上限（20 个）。");
      if (!time && !at) return deny("需要 time（循环：HH:MM）或 at（一次性：YYYY-MM-DD HH:MM）。");
      if (time && at) return deny("time 和 at 只能选一个：循环任务用 time，一次性任务用 at。");
      let normTime = "";
      if (time) {
        const tm = time.match(/^(\d{1,2}):([0-5]\d)$/);
        if (!tm || Number(tm[1]) > 23) return deny(`时间格式不对：「${time}」，应为 HH:MM 24 小时制。`);
        normTime = `${String(Number(tm[1])).padStart(2, "0")}:${tm[2]}`;
      }
      let normAt = "";
      if (at) {
        const am = at.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[\sT](\d{1,2}):(\d{2})$/);
        if (!am) return deny(`一次性时间格式不对：「${at}」，应为 YYYY-MM-DD HH:MM。`);
        const dt = new Date(Number(am[1]), Number(am[2]) - 1, Number(am[3]), Number(am[4]), Number(am[5]));
        if (isNaN(dt.getTime())) return deny(`无效时间：${at}`);
        const now = input.now ?? new Date();
        if (dt.getTime() < now.getTime() - 60_000) return deny(`「${at}」已经过去了，换一个将来的时间。`);
        normAt = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
      }
      if (!prompt) return deny("任务内容缺失。");
      let target: ScheduledTask["target"];
      if (targetStr === "group") {
        const gid = String(input.groupId ?? "").trim();
        if (!gid) return deny("target 为 group 时缺少群号。");
        target = { type: "group", id: gid };
      } else if (targetStr === "private") {
        target = { type: "private", id: owner };
      } else {
        return deny("target 应为 group 或 private。");
      }
      const task: ScheduledTask = {
        name,
        enabled: true,
        target,
        prompt: prompt.slice(0, 300),
        ...(normTime ? { time: normTime } : {}),
        ...(normAt ? { at: normAt } : {}),
      };
      if (Array.isArray(input.days) && input.days.length) {
        task.days = (input.days as unknown[]).map(Number).filter((n) => n >= 1 && n <= 7);
      }
      return saved([...current, task]);
    }
    case "delete": {
      const name = String(input.name ?? "").trim();
      const next = current.filter((task) => task.name !== name);
      if (next.length === current.length) return deny(`没有找到「${name}」。`);
      return saved(next);
    }
    case "enable":
    case "disable": {
      const name = String(input.name ?? "").trim();
      const found = current.find((task) => task.name === name);
      if (!found) return deny(`没有找到「${name}」。`);
      const next = current.map((task) => (task.name === name ? { ...task, enabled: op === "enable" } : task));
      return saved(next);
    }
    default:
      return deny("未知操作，应为 add/list/delete/enable/disable。");
  }
}
