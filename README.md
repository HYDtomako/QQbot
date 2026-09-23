# pi-NapCatQQ 机器人

以 [pi](https://github.com/earendil-works/pi)（coding agent）为大脑、[NapCatQQ](https://github.com/NapNeko/NapCatQQ)（OneBot 11 协议）为连接，跑在 QQ 上的机器人。

```
QQ 群/私聊 ──► NapCatQQ（OneBot 11 正向 WebSocket :3001）
                    │
        bot 桥接服务（src/main.ts）
                    │ 每条消息 spawn 一个 `pi -p --no-session` 子进程（无状态）
                    ▼
            pi coding agent（沙箱目录 sandbox/）
```

## 功能与安全

- **定位**：知识服务型助手——答疑解惑、信息输出、知识总结、建议提供；不涉及 coding，无 shell/文件工具。
- **能力**：所有人统一只有 `web_search`（Tavily 搜索）+ `web_read`（读网页，国内站直连；不访问外网）；`--tools` 白名单硬限制，碰不到本地文件和命令。
- **文件读取**（`src/attachments.ts` + `src/docparse.ts`）：发来的文件先转成文本再交给 pi（pi 的附件只认图片与文本，二进制文档必须先取文）。
  - 纯文本（txt/md/csv/json/yaml/xml/ini/字幕等）：原样读，UTF-8 / GBK / UTF-16 自动识别。
  - PDF：调 `pdftotext` 取文，分页处插入页码标记；扫描件提取不到文字时如实回复，不编内容。
  - Word / Excel / PPT（docx/xlsx/pptx）：本地解压 OOXML 取文——Word 标题转 Markdown 标题、表格同一行用制表符对齐；Excel 多工作表分别列出、日期序列号还原成日期；PPT 按页分块。
  - 图片走多模态直接看；压缩包、音视频、旧版 doc/xls/ppt 会如实回复读不了（并提示另存为 docx/pdf）。
  - 上下文闸门：单文件文本上限 30000 字、单条消息 60000 字、单条消息最多 5 个文件（超出截断或拒绝，参数在 `config.json` 的 `files`）。
- **权限（说话层）**：只认 QQ 号（`config.bot.owner`，配置里指定），与任何群身份无关；主人的指令绝对优先，其他人仅可提问。
- **触发规则**：私聊仅白名单（`bot.whitelist`）触发；群聊任何人 @ 机器人即可（真 at 或文本 @ 均可，光 @ 不说话也会回应）。
- **人设**：`sandbox/.pi/SYSTEM.md`（企鹅主任），改动后下一条消息自动生效。
- **群管-反刷屏**（`src/antispam.ts`，机械判定不经 LLM）：同群相同文本 90 秒内出现 ≥3 次（含单人连发与多人跟风）→ 自动撤回除最先一条外的全部消息，并输出"本群禁止刷屏行为"。院长消息参与计数但豁免撤回。注意 QQ 平台限制：管理员无法撤回其他管理员/群主的消息（撤回失败会记日志）；要完全覆盖需 bot 为群主。参数在 `config.json` 的 `antispam`。
- **课表查询**（所有人可用，`schedule/zf.ts`）：发"课表/今天课表/明天课表/后天课表/本周课表"，直答"节次+课程+教室+老师+开始时间"。只读查询，无法经此改动任何东西；登录凭据在脱敏清单中，任何回复都不会出现。自动登录教务系统（RSA 加密，无需验证码），按周次拉取（服务端解析单双周），缓存 6 小时。配置在 `config.json` 的 `jw`。
- **长期记忆**（`memory/long-term/<QQ>.jsonl`，仅院长可写）：院长说"记住X"→ pi 调 `remember` 工具永久保存；每次对话自动把本人条目附在消息前；`recall` 查、`forget` 删（删前复述确认）。每人独立档案，只注入本人的对话；记忆内容不能改变权限规则。
- **记忆**：每用户独立 5 分钟滚动窗口（`config.memory`）——窗口内续接同一 pi 会话（完整上下文）；过期后旧窗口惰性压缩成 ≤300 字摘要带入新窗口（只在实际有人回来时才花这次调用，窗口过小 <1KB 不压缩），归档 24h 后清理。同用户消息串行处理。
- 超长回复自动分片；群聊回复以「聊天记录」卡片发送（send_forward_msg，单条）；单次处理超时 240 秒自动终止。

## 启动（日常使用）

开机后按顺序双击两个脚本。启动窗口显示进度，**成功后自动关闭，服务转入后台运行**，桌面不留常驻窗口：

1. **先启动 NapCat**：双击 `start-napcat.bat`（含机器人 QQ 号，已被 .gitignore 忽略；首次使用从 `start-napcat.example.bat` 复制并填入自己的值）
   - 自动用机器人号快速登录；登录态失效时会回退二维码，脚本会自动弹出二维码图片，用手机 QQ 扫码即可。
   - 若提示「已在运行」属正常防重复保护；bot 无反应时先双击 `clean-bot.bat` 清理残留进程再重新启动。
   - 若电脑上的官方 QQ 正登录着机器人号，会登录失败——先退出官方 QQ 再启动（手机 QQ 不受影响）。
2. **再启动桥接服务**：双击 `start-bot.bat`（会自动清掉旧桥接进程，防止消息重复回复）

两个窗口都自动关闭 = 启动完成（WebUI 能开、bot 会回消息）。运行日志在 `log-napcat.txt` / `log-bot.txt`（每次启动重写）。

停止/排障：双击 `clean-bot.bat` 一键结束所有相关进程，或直接关机（下次开机重新双击两个脚本即可）。

> 注意：`.bat` 脚本必须保持 **ANSI/GBK 编码**（中文 Windows 的 cmd 要求），且每行注释/echo 的行尾保留一个 ASCII 字符（如英文句点）——否则会出现乱码命令与闪退。

### WebUI 面板

- 地址：http://127.0.0.1:6099/webui
- 密钥（token）在 `<NapCat目录>\napcat\config\webui.json` 的 `token` 字段（首次启动自动生成），登录时填入即可。密钥用于防止本机其他程序访问面板，请勿泄露。

### 人设提示词

机器人的身份设定在 `sandbox/.pi/SYSTEM.md`，改动后下一条消息自动生效。

## 配置

- 首次使用：把 `config.example.json` 复制为 `config.json`，按里面的说明填入自己的值（QQ 号、token、API key、教务账号等）。**`config.json` 已被 .gitignore 忽略，不会进仓库。**
- 主要字段：
  - `onebot.wsUrl` / `onebot.token`：连 NapCat 的 WebSocket 地址与密钥（与 NapCat 的 `onebot11_<QQ号>.json` 中 `websocketServers[0]` 一致）
  - `bot.owner`：最高权限者 QQ 号；`bot.whitelist`：私聊白名单
  - `pi.models`：可用模型别名（如 `{"deepseek-flash": "deepseek-flash", "glm": "aliyun-maas/glm-5.3"}`）
  - `pi.tavilyKey`：Tavily 搜索 key；`pi.aliyunKey` / `pi.aliyunBaseUrl`：百炼实例（用 GLM 时需要）
  - `jw`：教务系统账号/密码/学年学期/班级/节次时间（课表功能用）
  - `antispam` / `memory`：反刷屏与记忆参数
  - `files`：附件处理参数（`maxTextChars` 单文件文本上限、`maxTotalChars` 单条消息总量、`pdftotext` 可执行文件路径）
- NapCat OneBot 网络：`<NapCat目录>\napcat\config\onebot11_<QQ号>.json`（启用正向 WS，端口与 config 一致，改后热重载）。
- 两端 token 必须一致：`config.json` 的 `onebot.token` 与 OneBot 配置里 `websocketServers[0].token` 相同。

## 依赖与环境

- **Node ≥ 22.19**（用到原生 TS 运行与 `--experimental` 特性）。
- **pi**：`npm i -g @earendil-works/pi-coding-agent`。Windows 上若 Git 不在默认路径，需在 `~/.pi/agent/settings.json` 里设 `shellPath` 指向 `bash.exe`。
- **pdftotext**（读 PDF 用）：Git for Windows 自带（`<Git安装目录>/mingw64/bin/pdftotext.exe`），桥接会从 PATH 与 Git 安装目录自动查找；找不到时 PDF 会如实回复读不了，可在 `config.json` 的 `files.pdftotext` 指定完整路径。Word/Excel/PPT 不需要外部工具。
- **NapCatQQ**：Shell 版解压即用；若启动报 `wrapper.node` 加载失败，从 QQ 安装包的 `Files/versions/*/resources/app/` 提取 `crypto.dll`、`ssl.dll`、`dbghelp.dll` 放入 NapCat 目录。
- **课表的加密脚本**：`schedule/vendor/` 下的 jsbn/rsa 等文件来自教务系统页面（不随仓库分发）。首次使用课表功能前，从教务系统登录页引用的路径下载：
  `http://<教务系统域名>/zftal-ui-v5-1.0.2/assets/plugins/crypto/rsa/{jsbn,prng4,rng,rsa,base64}.js`

### 网络访问范围

机器人**不访问外网**：`web_read` 直连国内站点，境外站点（YouTube、X、OpenAI 等）读不到，会如实说明并改用搜索找替代信息。搜索（Tavily）走直连。所有输出经统一脱敏（密钥不外泄）。

### 文档取文回归

`src/docparse.ts`（PDF/Word/Excel/PPT 取文）可以脱离 bot 进程直接验证，改动后建议拿几个真实文件跑一遍：

```bash
node scripts/docparse-selftest.ts [-v] 文件1 文件2 ...
```

输出每个文件是否读成文本、字符数、转换说明与耗时；`-v` 会打印正文预览，用来检查表格是否对得齐、日期是否还原、PDF 分页标记是否正常。

### 注意

- 机器人号与官方桌面 QQ **互斥**：同一账号同一时间只能一个桌面端在线，用机器人前需退出官方 QQ（手机端不受影响）。
- 第三方协议客户端（NapCat）可能触发腾讯风控（强制下线 / 要求身份验证），建议用独立小号做机器人。
