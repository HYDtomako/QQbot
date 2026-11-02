/**
 * 输出脱敏用的密钥清单。
 *
 * 百炼域名只从 pi.aliyunBaseUrl 解析，不写死任何实例主机名。
 * 短于 8 个字符的值不纳入精确替换，避免把普通聊天里的短词整段抹掉。
 */

export interface RedactSource {
  onebot?: { token?: string };
  pi?: { tavilyKey?: string; aliyunKey?: string; aliyunBaseUrl?: string };
  entertainment?: { tts?: { apiKey?: string } };
  jw?: { password?: string };
}

export interface SecretPack {
  /** 按字面量替换的密钥（token、API key、密码、完整 base URL）。 */
  values: string[];
  /** 从 aliyunBaseUrl 解析出的主机名，大小写不敏感替换。 */
  hosts: string[];
}

const GENERIC_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const MIN_SECRET_LEN = 8;

function pushSecret(out: string[], raw: unknown): void {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length >= MIN_SECRET_LEN && !out.includes(value)) out.push(value);
}

/** 从百炼 base URL 取出应脱敏的主机名。无效地址、回环地址不返回。 */
export function bailianHost(baseUrl: string | undefined): string | undefined {
  const raw = String(baseUrl ?? "").trim();
  if (!raw) return undefined;
  let host = "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    host = url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (!host || host.length < MIN_SECRET_LEN || !host.includes(".") || GENERIC_HOSTS.has(host)) return undefined;
  return host;
}

export function collectSecrets(src: RedactSource): SecretPack {
  const values: string[] = [];
  pushSecret(values, src.onebot?.token);
  pushSecret(values, src.pi?.tavilyKey);
  pushSecret(values, src.pi?.aliyunKey);
  pushSecret(values, src.entertainment?.tts?.apiKey);
  pushSecret(values, src.jw?.password);
  const base = typeof src.pi?.aliyunBaseUrl === "string" ? src.pi.aliyunBaseUrl.trim() : "";
  const host = bailianHost(base);
  if (base.length >= MIN_SECRET_LEN && host) pushSecret(values, base);
  return { values, hosts: host ? [host] : [] };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactText(input: string, pack: SecretPack): string {
  let out = input;
  const values = [...pack.values].sort((a, b) => b.length - a.length);
  for (const secret of values) out = out.split(secret).join("[密钥已隐藏]");
  for (const host of pack.hosts) {
    out = out.replace(new RegExp(escapeRegExp(host), "gi"), "[密钥已隐藏]");
  }
  out = out.replace(/\b(?:sk|tvly)-[A-Za-z0-9_-]{8,}\b/g, "[密钥已隐藏]");
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{10,}/gi, "Bearer [已隐藏]");
  return out;
}
