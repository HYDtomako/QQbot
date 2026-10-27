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
  /** 联网工具（web_search / web_read）参数 */
  web?: {
    /** web_read 单页正文上限（字符），超出截断，默认 50000 */
    maxTextChars?: number;
  };
  tasks?: Array<{
    name: string;
    time: string; // HH:MM 每日触发
    days?: number[]; // 1-7（周一=1），缺省每天
    enabled?: boolean;
    target: { type: "group" | "private"; id: string };
    prompt: string;
  }>;
  /** 娱乐模式（主动插话）：只对 modes.json 里开了娱乐模式的群生效 */
  entertainment?: {
    /** 目标回复频率 0~1，越小越少主动开口，默认 0.3 */
    replyFrequency?: number;
    media?: {
      /** 娱乐群来图后台识别，默认开启；仅处理新消息，不回扫历史。 */
      enabled?: boolean;
      /** 可选视觉模型别名或 pi 模型规格；不填跟随当前对话模型。 */
      model?: string;
    };
    /** 娱乐模式语音回复（MiniMax T2A / fish.audio）；缺省或 enabled=false 视为关闭。 */
    tts?: {
      enabled?: boolean;
      /** 合成服务商：minimax（缺省，老配置行为不变）或 fish。 */
      provider?: "minimax" | "fish";
      /** fish 走的本机 SOCKS5 代理，形如 socks5://127.0.0.1:10808；空串表示直连。 */
      proxy?: string;
      /** 服务密钥；缺失时功能保持关闭，不会被记录或发送。 */
      apiKey?: string;
      /** 接口根地址：minimax 实际请求 `{baseUrl}/v1/t2a_v2`，fish 请求 `{baseUrl}/v1/tts`。 */
      baseUrl?: string;
      /** 语音模型：minimax 默认 speech-2.8-turbo，fish 用 s2.1-pro-free。 */
      model?: string;
      /** 音色 ID：minimax 默认 female-shaonv，fish 为 reference_id。 */
      voiceId?: string;
      speed?: number;
      vol?: number;
      pitch?: number;
      /** 每条纯文字回复转语音的概率 0~1，默认 0.35。 */
      probability?: number;
      /** 可朗读文本的最大字数，默认 80。 */
      maxChars?: number;
      /** 音频格式，默认 mp3。 */
      format?: string;
      /**
       * 是否允许院长与白名单以外的人调用 voice_send 指定语音；
       * 缺省 false（仅院长与白名单可用），不影响上面的概率钩子。
       */
      allowOthers?: boolean;
    };
  };
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
