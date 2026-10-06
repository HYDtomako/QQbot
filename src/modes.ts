import { readFileSync, writeFileSync, existsSync } from "node:fs";

/**
 * 娱乐模式状态：哪些群开了「像麦麦一样主动参与」的娱乐模式。
 * 只有院长（owner）能改动，改动落在 modes.json，桥接重启后保留。
 *
 * 第一期只做状态与开关；真正的「主动插话」门控后续接入。
 */
export interface ModesState {
  entertainment: {
    /** 已开启娱乐模式的群号列表 */
    groups: string[];
  };
}

export class Modes {
  private readonly file: string;
  private state: ModesState;

  constructor(file: string) {
    this.file = file;
    this.state = this.load();
  }

  private load(): ModesState {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<ModesState>;
        if (raw && raw.entertainment && Array.isArray(raw.entertainment.groups)) {
          return { entertainment: { groups: raw.entertainment.groups.map(String) } };
        }
      }
    } catch {
      /* 文件缺失或损坏 → 用空状态 */
    }
    return { entertainment: { groups: [] } };
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2) + "\n");
  }

  isEntertainment(groupId: string): boolean {
    return this.state.entertainment.groups.includes(String(groupId));
  }

  /** 开/关某个群的娱乐模式，返回改动后该群是否处于开启状态。 */
  setEntertainment(groupId: string, on: boolean): boolean {
    const g = String(groupId);
    const set = new Set(this.state.entertainment.groups);
    if (on) set.add(g);
    else set.delete(g);
    this.state.entertainment.groups = [...set];
    this.save();
    return on;
  }

  listEntertainment(): string[] {
    return [...this.state.entertainment.groups];
  }
}

/**
 * 识别娱乐模式开关指令（仅院长可用，命中与否由调用方校验身份）。
 * 覆盖常见说法：开启/打开/启动/进入 娱乐模式；关闭/退出/停止/关掉 娱乐模式。
 */
export function matchModeCommand(text: string): { action: "on" | "off" } | null {
  const t = text.trim().replace(/[，,。！？!?~～\s]+$/g, "");
  if (!/娱乐模式|娱乐态/.test(t)) return null;
  if (/(?:开启|打开|启动|进入|开一下|开来|开起|启用)/.test(t)) return { action: "on" };
  if (/(?:关闭|关掉|退出|停止|结束|停用|不要)/.test(t)) return { action: "off" };
  return null;
}

/** 从指令文本里抽一个群号（私聊里指定目标群时用），没有则返回 null。 */
export function extractGroupId(text: string): string | null {
  const m = text.match(/\b(\d{6,12})\b/);
  return m ? m[1] : null;
}
