import { readFileSync } from "node:fs";

export interface BotConfig {
  onebot: { wsUrl: string; token: string };
  bot: {
    selfId: string;
    nickname: string;
    defaultGroup?: string;
    atAliases: string[];
    owner: string;
    whitelist: string[];
    maxConcurrent: number;
    timeoutMs: number;
  };
  pi: {
    command: string;
    args: string[];
    thinking: string;
    tavilyKey?: string;
    aliyunKey?: string;
    aliyunBaseUrl?: string;
    defaultModel?: string;
    models?: Record<string, string>;
  };
  antispam?: {
    enabled?: boolean;
    windowMs?: number;
    minRepeats?: number;
    noticeText?: string;
    exemptUsers?: string[];
  };
  memory?: {
    enabled?: boolean;
    windowMs?: number;
    summarizeMinBytes?: number;
  };
  /** 附件（图片/文件）处理参数 */
  files?: {
    /** 单个文件的文本上限（字符），超出截断，默认 30000 */
    maxTextChars?: number;
    /** 单条消息所有附件的文本总量上限（字符），默认 60000 */
    maxTotalChars?: number;
    /** pdftotext 可执行文件路径（默认从 PATH 与 Git for Windows 目录自动查找） */
    pdftotext?: string;
  };
  tasks?: Array<{
    name: string;
    time: string; // HH:MM 每日触发
    days?: number[]; // 1-7（周一=1），缺省每天
    enabled?: boolean;
    target: { type: "group" | "private"; id: string };
    prompt: string;
  }>;
  jw?: {
    user: string;
    password: string;
    xnm: string;
    xqm: string;
    className?: string;
    periodTimes?: Record<string, string>;
    baseUrl?: string;
  };
}

export function loadConfig(path: string): BotConfig {
  const cfg = JSON.parse(readFileSync(path, "utf8")) as BotConfig;
  if (!cfg.onebot?.wsUrl) throw new Error(`config ${path}: onebot.wsUrl 缺失`);
  if (!Array.isArray(cfg.bot?.whitelist)) throw new Error(`config ${path}: bot.whitelist 缺失`);
  return cfg;
}
