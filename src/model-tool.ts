/**
 * model_manage 的桥接侧实现。
 *
 * 谁能查/切模型只看本轮回环凭据绑上的 QQ（与 voice_send / tell_guga / mode_manage 同一枚 token）。
 * 模型参数里的提问者 QQ 不进这个函数。
 */

export interface ModelManageRequest {
  /** 桥接从 OneBot 事件绑定的提问者，不是模型参数。 */
  asker: string;
  owner: string;
  op: unknown;
  alias: unknown;
  models: Record<string, string>;
  defaultModel?: string;
  /** 桥接当前生效的别名。 */
  current: string;
}

export interface ModelManageResult {
  ok: boolean;
  text: string;
  /** 有值时桥接应写入 .model-state.json。拒绝、查询、已是当前模型时绝不带这个字段。 */
  nextAlias?: string;
}

function deny(text: string): ModelManageResult {
  return { ok: false, text };
}

export function runModelManage(input: ModelManageRequest): ModelManageResult {
  const asker = String(input.asker ?? "").trim();
  const owner = String(input.owner ?? "").trim();
  if (!owner || !asker || asker !== owner) return deny("只有院长可以查询或切换模型。");

  const models = input.models && typeof input.models === "object" ? input.models : {};
  const aliases = Object.keys(models);
  const saved = String(input.current ?? "").trim();
  const fallback = String(input.defaultModel ?? aliases[0] ?? "");
  const current = saved && models[saved] ? saved : fallback;

  const op = String(input.op ?? "").trim();
  switch (op) {
    case "status":
      return { ok: true, text: `当前模型：${current}（${models[current] ?? "?"}）` };
    case "list":
      return {
        ok: true,
        text: `可用模型：${aliases.map((a) => `${a}（${models[a]}）`).join("、")}。切换说法："切换模型 xxx" 或直接跟我说"换成 xxx"。`,
      };
    case "switch": {
      const raw = String(input.alias ?? "").trim().toLowerCase();
      if (!raw) return deny("要切到哪个模型？可用：" + aliases.join("、"));
      let alias = aliases.find((a) => a === raw) ?? "";
      if (!alias) alias = aliases.find((a) => models[a] === raw || models[a].endsWith("/" + raw)) ?? "";
      if (!alias) alias = aliases.find((a) => a.startsWith(raw) || raw.startsWith(a) || models[a].toLowerCase().includes(raw)) ?? "";
      if (!alias) return deny(`没有「${raw}」这个模型。可用：${aliases.join("、")}`);
      if (alias === current) return { ok: true, text: `当前已经在用 ${alias} 了。` };
      return {
        ok: true,
        text: `已切到 ${alias}（${models[alias]}）。全局生效，十几秒后所有对话都用它。`,
        nextAlias: alias,
      };
    }
    default:
      return deny("未知操作，应为 status / switch / list。");
  }
}
