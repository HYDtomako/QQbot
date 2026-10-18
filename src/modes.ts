import { readFileSync, existsSync } from "node:fs";

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

  /** 重新读取 modes.json（模型通过 mode_manage 工具修改后由桥接热更新）。 */
  reload(): void {
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

  isEntertainment(groupId: string): boolean {
    return this.state.entertainment.groups.includes(String(groupId));
  }

  listEntertainment(): string[] {
    return [...this.state.entertainment.groups];
  }
}
