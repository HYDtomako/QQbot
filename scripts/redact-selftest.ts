import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bailianHost, collectSecrets, redactText } from "../src/redact.ts";

const DEAD_HOST = "ws-ysr9lqb3i48ep149.cn-beijing.maas.aliyuncs.com";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pack = collectSecrets({
  onebot: { token: "onebot-token-value" },
  pi: {
    tavilyKey: "tvly-testkeyvalue",
    aliyunKey: "aliyun-key-value-xxxx",
    aliyunBaseUrl: "https://example-instance.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  },
  entertainment: { tts: { apiKey: "tts-key-value-xxxx" } },
  jw: { password: "jw-password-value" },
});

assert.ok(pack.values.includes("onebot-token-value"));
assert.ok(pack.values.includes("tts-key-value-xxxx"));
assert.ok(pack.values.includes("aliyun-key-value-xxxx"));
assert.ok(pack.values.includes("jw-password-value"));
assert.deepEqual(pack.hosts, ["example-instance.cn-beijing.maas.aliyuncs.com"]);
assert.equal(pack.hosts.includes(DEAD_HOST), false);
assert.equal(pack.values.some((v) => v.includes(DEAD_HOST)), false);
console.log("PASS secrets: onebot.token、tts.apiKey 在清单内；未配置的死域名不在");

const redacted = redactText(
  [
    "token onebot-token-value",
    "tts tts-key-value-xxxx",
    "host Example-Instance.CN-BEIJING.maas.aliyuncs.com",
    "url https://example-instance.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    `dead ${DEAD_HOST}`,
    "bearer Bearer abcdefghijklmnop",
  ].join("\n"),
  pack,
);
assert.equal(redacted.includes("onebot-token-value"), false);
assert.equal(redacted.includes("tts-key-value-xxxx"), false);
assert.equal(redacted.includes("example-instance"), false);
assert.match(redacted, new RegExp(DEAD_HOST));
assert.match(redacted, /Bearer \[已隐藏\]/);
console.log("PASS redact: 配置里的 token、语音 key、百炼主机被抹掉；死域名原文保留");

const derived = collectSecrets({
  pi: { aliyunBaseUrl: `https://${DEAD_HOST}/compatible-mode/v1` },
});
assert.deepEqual(derived.hosts, [DEAD_HOST]);
assert.equal(redactText(`see ${DEAD_HOST}`, derived).includes(DEAD_HOST), false);
console.log("PASS redact: 百炼主机只在它就是 aliyunBaseUrl 时才脱敏");

assert.equal(bailianHost("https://127.0.0.1:8443/v1"), undefined);
assert.equal(bailianHost("不是一个 URL"), undefined);
assert.equal(bailianHost(undefined), undefined);
const short = collectSecrets({ onebot: { token: "short" }, entertainment: { tts: { apiKey: "1234567" } } });
assert.deepEqual(short.values, []);
const exact = collectSecrets({ onebot: { token: "12345678" } });
assert.deepEqual(exact.values, ["12345678"]);
console.log("PASS redact: 回环地址和短于 8 字符的值不进精确替换");

const main = readFileSync(path.join(root, "src", "main.ts"), "utf8");
const redactSrc = readFileSync(path.join(root, "src", "redact.ts"), "utf8");
assert.equal(main.includes(DEAD_HOST), false, "main.ts 不应再写死百炼实例");
assert.equal(redactSrc.includes(DEAD_HOST), false, "redact.ts 不应再写死百炼实例");
assert.match(main, /collectSecrets\(config\)/);
console.log("PASS source: 死域名不再写死在桥接或脱敏模块里");
console.log("redact-selftest: all passed");
