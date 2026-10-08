export function isLegacyProtected(kind: "group" | "private", id: string): boolean {
  const key = kind === "group" ? "QQ_KNOWLEDGE_PROTECTED_GROUPS" : "QQ_KNOWLEDGE_PROTECTED_USERS";
  const value = process.env[key];
  if (value === undefined) return false;
  try {
    const ids: unknown = JSON.parse(value);
    if (!Array.isArray(ids) || !ids.every(x => typeof x === "string" && /^[1-9]\d{4,19}$/.test(x))) return true;
    return ids.includes(id);
  } catch {
    return true;
  }
}
