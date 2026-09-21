/**
 * 正方教务系统客户端（青岛工学院）：自动登录 + 按周拉取个人课表。
 *
 * 登录：教务系统自带 jsbn/rsa.js 加密栈（schedule/vendor/，与浏览器一致），
 * RSA 加密密码 → hex2b64 → 提交 → 跟随跳转链激活会话。
 * 课表：POST /kbcx/xskbcxMobile_cxXsgrkb.html（xnm+xqm+zs 周次）→ 该周真实课表
 *（服务端已解析单双周/调休，无需本地判断）。当前周次取自主课表页 zs_hide 字段。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export interface JwConfig {
  user: string;
  password: string;
  xnm: string; // 学年，如 2026 表示 2026-2027 学年
  xqm: string; // 学期码（正方：3=第一学期 12=第二学期 16=第三学期）
  className?: string; // 院长所在班级（用于过滤合表），如 （2）班
  periodTimes?: Record<string, string>; // 节次起始时间映射
  baseUrl?: string;
}

export interface Lesson {
  kcmc: string; // 课程名
  xqj: number; // 星期几 1-7
  jc: string; // 节次，如 3-4节
  jcStart: number; // 起始节次
  cdmc: string; // 教室
  xm: string; // 教师
}

export interface ScheduleBundle {
  fetchedAt: string;
  currentZs: number; // 系统认定的当前教学周
  weeks: Record<string, Lesson[]>; // 周次 -> 该周课表
}

const MODULE_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const VENDOR_DIR = path.join(MODULE_DIR, "vendor");
const CACHE_PATH = path.join(MODULE_DIR, "cache.json");
const CACHE_TTL_MS = 6 * 3600_000;
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

let classFilter = "";
export function setClassFilter(name: string): void {
  classFilter = name ?? "";
}

function loadVendorCrypto(): void {
  Object.defineProperty(globalThis, "navigator", {
    value: { appName: "Mozilla", appVersion: "5.0", userAgent: UA },
    configurable: true,
  });
  (globalThis as Record<string, unknown>).window = globalThis;
  const code = ["jsbn", "prng4", "rng", "rsa", "base64"]
    .map((f) => readFileSync(path.join(VENDOR_DIR, f + ".js"), "utf8"))
    .join("\n");
  (0, eval)(code);
}

class CookieJar {
  private jar = new Map<string, string>();
  header(): string {
    return [...this.jar.entries()].map(([k, v]) => k + "=" + v).join("; ");
  }
  save(res: Response): void {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const eq = kv.indexOf("=");
      this.jar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
  }
}

/** 一次登录会话里拉取：当前周参数 + 指定周次列表（去重合并）。 */
export async function fetchScheduleBundle(cfg: JwConfig, wantedZs: number[] = []): Promise<ScheduleBundle> {
  loadVendorCrypto();
  const base = cfg.baseUrl ?? "http://jw.qit.edu.cn";
  const jar = new CookieJar();
  const H = (extra?: Record<string, string>) => ({ "User-Agent": UA, Cookie: jar.header(), ...extra });

  const page = await fetch(base + "/jwglxt/xtgl/login_slogin.html", { headers: H() });
  jar.save(page);
  const html = await page.text();
  const csrftoken = html.match(/name="csrftoken"[^>]*value="([^"]+)"/)?.[1];
  if (!csrftoken) throw new Error("教务系统登录页获取失败（无 csrftoken）");

  const pk = (await (await fetch(base + "/jwglxt/xtgl/login_getPublicKey.html", { headers: H() })).json()) as {
    modulus: string;
    exponent: string;
  };
  const g = globalThis as Record<string, unknown>;
  const RSAKeyCtor = g.RSAKey as new () => {
    setPublic(n: string, e: string): void;
    encrypt(t: string): string;
  };
  const b64tohex = g.b64tohex as (s: string) => string;
  const hex2b64 = g.hex2b64 as (s: string) => string;
  const rsaKey = new RSAKeyCtor();
  rsaKey.setPublic(b64tohex(pk.modulus), b64tohex(pk.exponent));
  const mm = hex2b64(rsaKey.encrypt(cfg.password));

  const form = new URLSearchParams();
  form.append("csrftoken", csrftoken);
  form.append("language", "zh_CN");
  form.append("ydType", "");
  form.append("yhm", cfg.user);
  form.append("mm", mm);
  form.append("mm", mm);
  const login = await fetch(base + "/jwglxt/xtgl/login_slogin.html", {
    method: "POST",
    headers: H({ "Content-Type": "application/x-www-form-urlencoded", Origin: base, Referer: base + "/jwglxt/xtgl/login_slogin.html" }),
    body: form.toString(),
    redirect: "manual",
  });
  jar.save(login);
  const respHtml = await login.text();
  if (respHtml.includes("不正确")) throw new Error("教务系统账号或密码不正确（或被临时锁定）");

  let url = login.headers.get("location");
  let hops = 0;
  while (url && hops < 5) {
    const r = await fetch(url.startsWith("http") ? url : base + url, { headers: H(), redirect: "manual" });
    jar.save(r);
    url = r.headers.get("location");
    hops++;
  }

  // 主课表页：系统认定的当前周（zs_hide）
  const kbPage = await fetch(base + "/jwglxt/kbcx/xskbcxMobile_cxTimeTableIndex.html", { headers: H() });
  jar.save(kbPage);
  const kbHtml = await kbPage.text();
  const zsStr =
    kbHtml.match(/id="zs_hide"[^>]*value="([^"]*)"/)?.[1] ?? kbHtml.match(/zs_hide[\s\S]{0,120}?value="([^"]*)"/)?.[1] ?? "";
  const currentZs = Number(zsStr);
  if (!currentZs || currentZs < 1) throw new Error("无法确定当前教学周（zs_hide 缺失）");

  const toLessons = (list: Record<string, unknown>[]): Lesson[] => {
    const all = list.map((x) => ({
      kcmc: String(x.kcmc ?? ""),
      xqj: Number(x.xqj ?? 0),
      jc: String(x.jc ?? ""),
      jcStart: Number(String(x.jcs ?? "1").split("-")[0] ?? 1),
      cdmc: String(x.cdmc ?? "").replace(/（/g, "(").replace(/）/g, ")"),
      xm: String(x.xm ?? ""),
      jxbzc: String(x.jxbzc ?? ""),
    }));
    const cls = classFilter.trim();
    const filtered = cls ? all.filter((l) => l.jxbzc.includes(cls)) : all;
    return filtered
      .filter((l) => l.kcmc && l.xqj >= 1 && l.xqj <= 7)
      .map(({ jxbzc: _j, ...rest }) => rest);
  };

  // 拉当前周 + 指定周（明天/后天跨周或任意未来日期时按需）
  const zsList = [...new Set([currentZs, currentZs + 1, ...wantedZs])].filter((z) => z >= 1);
  const weeks: Record<string, Lesson[]> = {};
  for (const zs of zsList) {
    const r = await fetch(base + "/jwglxt/kbcx/xskbcxMobile_cxXsgrkb.html?gnmkdm=N254395", {
      method: "POST",
      headers: H({
        Referer: base + "/jwglxt/kbcx/xskbcxMobile_cxTimeTableIndex.html",
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      }),
      body: new URLSearchParams({ xnm: cfg.xnm, xqm: cfg.xqm, zs: String(zs), kblx: "1", doType: "app" }).toString(),
    });
    const t = await r.text();
    let list: Record<string, unknown>[] = [];
    try {
      const j = JSON.parse(t);
      list = (j.kbList ?? []) as Record<string, unknown>[];
    } catch {
      throw new Error(`第 ${zs} 周课表拉取失败（返回非 JSON）`);
    }
    weeks[String(zs)] = toLessons(list);
  }

  return { fetchedAt: new Date().toISOString(), currentZs, weeks };
}

export function readCache(): ScheduleBundle | null {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as ScheduleBundle;
  } catch {
    return null;
  }
}

export function cacheIsFresh(cache: ScheduleBundle | null): boolean {
  return !!cache && Date.now() - new Date(cache.fetchedAt).getTime() < CACHE_TTL_MS;
}

export async function ensureSchedule(cfg: JwConfig, wantedZs: number[] = []): Promise<ScheduleBundle> {
  const cached = readCache();
  if (cacheIsFresh(cached) && wantedZs.every((z) => cached!.weeks[String(z)])) return cached!;
  const fresh = await fetchScheduleBundle(cfg, wantedZs);
  if (cached) fresh.weeks = { ...cached.weeks, ...fresh.weeks }; // 保留此前拉过的周
  writeCache(fresh);
  return fresh;
}

export function writeCache(cache: ScheduleBundle): void {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1));
}

const WEEKDAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** 生成某天（weekday 1-7，zs 目标周）的课表回答。dateLabel 用于显示具体日期。 */
export function answerDay(
  bundle: ScheduleBundle,
  weekday: number,
  zs: number,
  periodTimes?: Record<string, string>,
  dateLabel?: string,
): string {
  const wd = WEEKDAY_NAMES[weekday] ?? `星期${weekday}`;
  const head = dateLabel ? `${dateLabel}（${wd}，第 ${zs} 周）` : `${wd}（第 ${zs} 周）`;
  const lessons = (bundle.weeks[String(zs)] ?? [])
    .filter((l) => l.xqj === weekday)
    .sort((a, b) => a.jcStart - b.jcStart);
  if (lessons.length === 0) return `${head}没有课，好好休息～`;
  const lines = lessons.map((l, i) => {
    const start = periodTimes?.[String(l.jcStart)];
    const time = start ? `（${start} 开始）` : "";
    return `${i + 1}. ${l.jc} ${l.kcmc} @${l.cdmc}${l.xm ? "（" + l.xm + "）" : ""}${time}`;
  });
  return `${head}共 ${lessons.length} 节课：\n${lines.join("\n")}`;
}
