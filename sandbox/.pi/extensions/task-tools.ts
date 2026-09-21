/**
 * task-tools 扩展：让院长用自然语言管理定时任务。
 *
 * pi 理解院长的自然语言（如"每天早上七点半提醒我课表"），转成结构化参数调用本工具。
 * 工具读写 config.json 的 tasks 数组；桥接监视该文件变化后热更新调度器。
 *
 * 权限：仅院长（asker_qq 必须等于 config.bot.owner）——pi 从消息头部的来源标注取问话人 QQ。
 * 安全边界：任务执行时只有联网工具，无 shell，最坏情况也只是群消息内容问题。
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
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(MODULE_DIR, "../../..");
const CONFIG_PATH = path.join(ROOT_DIR, "config.json");

interface TaskItem {
  name: string;
  time?: string;
  at?: string;
  days?: number[];
  enabled?: boolean;
  target: { type: "group" | "private"; id: string };
  prompt: string;
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function readConfig(): Record<string, unknown> & { bot?: { owner?: string }; tasks?: TaskItem[] } {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

const SCHEMA = {
  type: "object",
  properties: {
    op: { type: "string", description: "操作：add（添加）/ list（列表）/ delete（删除）/ enable（启用）/ disable（停用）" },
    name: { type: "string", description: "任务名称（≤20 字），add/delete/enable/disable 时必填" },
    time: { type: "string", description: "循环任务时刻 HH:MM（24 小时制）：每天/每周重复时用；与 at 二选一" },
    at: { type: "string", description: "一次性任务时刻 \"YYYY-MM-DD HH:MM\"：只触发一次，触发后自动删除；与 time 二选一" },
    target: { type: "string", description: "输出去向：group（发到当前群）或 private（私聊院长），add 时必填" },
    group_id: { type: "string", description: "target 为 group 时的群号（从消息来源标注取）" },
    days: { type: "array", items: { type: "number" }, description: "配合 time 使用：周几触发（1=周一...7=周日），不传=每天" },
    prompt: { type: "string", description: "到点要执行的任务内容（一段给机器人自己的指令），add 时必填" },
    asker_qq: { type: "string", description: "提问者的 QQ 号（从消息来源标注取，用于权限校验）" },
  },
  required: ["op"],
};

export default function taskToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "task_manage",
    label: "Task Manage",
    description: "管理院长的定时任务（添加/列表/删除/启用/停用每日定时执行的任务）。",
    promptSnippet: "task_manage: add/list/delete/enable/disable scheduled tasks",
    promptGuidelines: [
      "仅当院长本人（来源标注里标为「院长」的那个人）要求管理定时任务时才调用；其他人的请求一律拒绝并说明只有院长可以。",
      "把院长的自然语言转成结构化参数，时间类型按他的说法选：",
      "  · \"每天X点\" → time=\"HH:MM\"（不传 days）",
      "  · \"每周三X点\" / \"周一和周五X点\" → time=\"HH:MM\" + days=[3] / [1,5]",
      "  · \"明天X点\" / \"9月25日X点\" / \"三天后X点\" → at=\"YYYY-MM-DD HH:MM\"（一次性，触发后自动删除）",
      "  日期要用 current_time 工具核对后再写，不要自己推算；不确定是每天还是一次时，问清楚再建。",
      "add 时 target 按院长意思选 group 或 private；group 需要传消息来源标注里的群号。",
      "本工具只支持\"每天 HH:MM 触发一次\"的定时任务，不支持每隔几分钟/几小时的间隔任务和一次性倒计时提醒；院长有这类需求时如实说明限制，可以提议改成每天固定时间的提醒。",
      "返回的执行结果要如实转告院长。",
    ],
    parameters: SCHEMA,
    async execute(_id, params) {
      const cfg = readConfig();
      const owner = String(cfg.bot?.owner ?? "");
      const asker = String(params.asker_qq ?? "").trim();
      if (asker !== owner) return text("只有院长可以管理定时任务。");
      if (!owner) return text("配置异常（未设置院长 QQ）。");

      const op = String(params.op ?? "").trim();
      const tasks: TaskItem[] = Array.isArray(cfg.tasks) ? (cfg.tasks as TaskItem[]) : [];
      const save = (newTasks: TaskItem[]): ToolResult => {
        cfg.tasks = newTasks;
        writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
        return text(`已完成。当前共 ${newTasks.length} 个定时任务。`);
      };

      switch (op) {
        case "list": {
          if (tasks.length === 0) return text("还没有定时任务。");
          const lines = tasks.map((t) => {
            const when = t.at ? `一次性 ${t.at}` : `${t.days?.length ? "每周" + t.days.map((d) => "一二三四五六日"[d - 1]).join("、") : "每天"} ${t.time}`;
            return `${t.enabled === false ? "[停用]" : "[启用]"} ${t.name} | ${when} | ${t.target.type === "group" ? "群" + t.target.id : "私聊"}`;
          });
          return text(`共 ${tasks.length} 个定时任务：\n${lines.join("\n")}`);
        }
        case "add": {
          const name = String(params.name ?? "").trim();
          const time = String(params.time ?? "").trim();
          const at = String(params.at ?? "").trim();
          const targetStr = String(params.target ?? "").trim();
          const prompt = String(params.prompt ?? "").trim();
          if (!name || name.length > 20) return text("任务名称缺失或过长（≤20 字）。");
          if (tasks.some((t) => t.name === name)) return text(`已有同名任务「${name}」。`);
          if (tasks.length >= 20) return text("任务数量已达上限（20 个）。");
          if (!time && !at) return text("需要 time（循环：HH:MM）或 at（一次性：YYYY-MM-DD HH:MM）。");
          if (time && at) return text("time 和 at 只能选一个：循环任务用 time，一次性任务用 at。");
          let normTime = "";
          if (time) {
            const tm = time.match(/^(\d{1,2}):([0-5]\d)$/);
            if (!tm || Number(tm[1]) > 23) return text(`时间格式不对：「${time}」，应为 HH:MM 24 小时制。`);
            normTime = `${String(Number(tm[1])).padStart(2, "0")}:${tm[2]}`;
          }
          let normAt = "";
          if (at) {
            const am = at.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[\sT](\d{1,2}):(\d{2})$/);
            if (!am) return text(`一次性时间格式不对：「${at}」，应为 YYYY-MM-DD HH:MM。`);
            const dt = new Date(Number(am[1]), Number(am[2]) - 1, Number(am[3]), Number(am[4]), Number(am[5]));
            if (isNaN(dt.getTime())) return text(`无效时间：${at}`);
            if (dt.getTime() < Date.now() - 60_000) return text(`「${at}」已经过去了，换一个将来的时间。`);
            normAt = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
          }
          if (!prompt) return text("任务内容缺失。");
          let target: TaskItem["target"];
          if (targetStr === "group") {
            const gid = String(params.group_id ?? "").trim();
            if (!gid) return text("target 为 group 时缺少群号。");
            target = { type: "group", id: gid };
          } else if (targetStr === "private") {
            target = { type: "private", id: owner };
          } else {
            return text("target 应为 group 或 private。");
          }
          const task: TaskItem = {
            name,
            enabled: true,
            target,
            prompt: prompt.slice(0, 300),
            ...(normTime ? { time: normTime } : {}),
            ...(normAt ? { at: normAt } : {}),
          };
          if (Array.isArray(params.days) && params.days.length) {
            task.days = (params.days as unknown[]).map(Number).filter((n) => n >= 1 && n <= 7);
          }
          const newTasks = [...tasks, task];
          return save(newTasks);
        }
        case "delete": {
          const name = String(params.name ?? "").trim();
          const newTasks = tasks.filter((t) => t.name !== name);
          if (newTasks.length === tasks.length) return text(`没有找到「${name}」。`);
          return save(newTasks);
        }
        case "enable":
        case "disable": {
          const name = String(params.name ?? "").trim();
          const t = tasks.find((x) => x.name === name);
          if (!t) return text(`没有找到「${name}」。`);
          const newTasks = tasks.map((x) => (x.name === name ? { ...x, enabled: op === "enable" } : x));
          return save(newTasks);
        }
        default:
          return text("未知操作，应为 add/list/delete/enable/disable。");
      }
    },
  });
}
