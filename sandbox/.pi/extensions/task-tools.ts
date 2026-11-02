/**
 * task-tools：把定时任务的增删改交给桥接。
 *
 * 身份与 voice_send 同一条回环通道（QQ_TASK_ENDPOINT / QQ_TASK_TOKEN）。
 * 本工具只提交任务字段。提问者 QQ 由桥接按本轮 OneBot 事件填写。
 * 私聊目标由桥接写成院长 QQ，模型填不了别人的号码。
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

const SCHEMA = {
  type: "object",
  properties: {
    op: { type: "string", description: "操作：add（添加）/ list（列表）/ delete（删除）/ enable（启用）/ disable（停用）" },
    name: { type: "string", description: "任务名称（≤20 字），add/delete/enable/disable 时必填" },
    time: { type: "string", description: "循环任务时刻 HH:MM（24 小时制）：每天/每周重复时用；与 at 二选一" },
    at: { type: "string", description: "一次性任务时刻 \"YYYY-MM-DD HH:MM\"：只触发一次，触发后自动删除；与 time 二选一" },
    target: { type: "string", description: "输出去向：group（发到群）或 private（私聊院长），add 时必填" },
    group_id: { type: "string", description: "target 为 group 时的目标群号。不要填写提问者 QQ。" },
    days: { type: "array", items: { type: "number" }, description: "配合 time 使用：周几触发（1=周一...7=周日），不传=每天" },
    prompt: { type: "string", description: "到点要执行的任务内容（一段给机器人自己的指令），add 时必填" },
  },
  required: ["op"],
};

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

const FIELDS = ["name", "time", "at", "target", "group_id", "prompt"] as const;

export default function taskToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "task_manage",
    label: "Task Manage",
    description: "管理院长的定时任务（添加/列表/删除/启用/停用）。身份由桥接按本轮 QQ 会话判定。",
    promptSnippet: "task_manage: add/list/delete/enable/disable scheduled tasks",
    promptGuidelines: [
      "仅当来源标注为「院长」的人要求管理定时任务时才调用；其他人一律拒绝，不要调用。",
      "不要填写提问者 QQ。桥接按这一轮会话判断是谁，填了也无效。私聊目标由桥接写成院长本人。",
      "把院长的自然语言转成结构化参数，时间类型按他的说法选：",
      "  · \"每天X点\" → time=\"HH:MM\"（不传 days）",
      "  · \"每周三X点\" / \"周一和周五X点\" → time=\"HH:MM\" + days=[3] / [1,5]",
      "  · \"明天X点\" / \"9月25日X点\" / \"三天后X点\" → at=\"YYYY-MM-DD HH:MM\"（一次性，触发后自动删除）",
      "  日期要用 current_time 工具核对后再写，不要自己推算；不确定是每天还是一次时，问清楚再建。",
      "add 时 target 按院长意思选 group 或 private；group 需要传目标群号。",
      "本工具只支持\"每天 HH:MM 触发一次\"的定时任务，不支持每隔几分钟/几小时的间隔任务和一次性倒计时提醒；院长有这类需求时如实说明限制，可以提议改成每天固定时间的提醒。",
      "返回的执行结果要如实转告院长。",
    ],
    parameters: SCHEMA,
    async execute(_id, params) {
      const endpoint = process.env.QQ_TASK_ENDPOINT ?? "";
      const token = process.env.QQ_TASK_TOKEN ?? "";
      if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/task-manage$/.test(endpoint) || !/^[a-f0-9]{64}$/.test(token)) {
        return text("本次会话没有任务管理权限。");
      }
      const payload: Record<string, unknown> = { op: String(params.op ?? "").trim() };
      for (const key of FIELDS) {
        if (params[key] !== undefined) payload[key] = params[key];
      }
      if (Array.isArray(params.days)) payload.days = params.days;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        });
        const value = await response.json() as { text?: string };
        if (typeof value.text !== "string") return text("任务服务返回异常，没有修改。");
        return text(value.text);
      } catch {
        return text("任务服务不可用，没有修改。");
      }
    },
  });
}
