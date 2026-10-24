# pi-NapCatQQ 机器人

以 [pi](https://github.com/earendil-works/pi)（coding agent）为大脑、[NapCatQQ](https://github.com/NapNeko/NapCatQQ)（OneBot 11 协议）为连接，跑在 QQ 上的机器人。

```
QQ 群/私聊 ──► NapCatQQ（OneBot 11 正向 WebSocket :3001）
                    │
        bot 桥接服务（src/main.ts）
                    │ 每条消息 spawn pi；新记忆使用受控上下文，旧模式可续接 session
                    ▼
            pi coding agent（沙箱目录 sandbox/）
```

## 功能与安全

- **定位**：知识服务型助手——答疑解惑、信息输出、知识总结、建议提供；不涉及 coding，无 shell/文件工具。
- **能力**：通过 `--tools` 限制模型可用工具，不开放任意 shell/文件工具；未接管的旧模式还提供名册、课表、任务等扩展，实际白名单见 `src/runner.ts`。启用新记忆的问答只开放联网、时间和受限记忆工具，不开放旧记忆、任意群日志及跨域发送工具。扩展代码本身仍在当前系统用户权限下运行，工作目录不等于操作系统沙箱。`web_read` 单页正文上限 50000 字，超出截断并标注；可在 `config.json` 的 `web.maxTextChars` 调整。
- **文件读取**（`src/attachments.ts` + `src/docparse.ts`）：发来的文件先转成文本再交给 pi（pi 的附件只认图片与文本，二进制文档必须先取文）。
  - 纯文本（txt/md/csv/json/yaml/xml/ini/字幕等）：原样读，UTF-8 / GBK / UTF-16 自动识别。
  - PDF：调 `pdftotext` 取文，分页处插入页码标记；扫描件提取不到文字时如实回复，不编内容。
  - Word / Excel / PPT（docx/xlsx/pptx）：本地解压 OOXML 取文——Word 标题转 Markdown 标题、表格同一行用制表符对齐；Excel 多工作表分别列出、日期序列号还原成日期；PPT 按页分块。
  - 图片走多模态直接看；压缩包、音视频、旧版 doc/xls/ppt 会如实回复读不了（并提示另存为 docx/pdf）。
  - 上下文闸门：单文件文本上限 30000 字、单条消息 60000 字、单条消息最多 5 个文件（超出截断或拒绝，参数在 `config.json` 的 `files`）。
- **权限（说话层）**：只认 QQ 号（`config.bot.owner`，配置里指定），与任何群身份无关；主人的指令绝对优先，其他人仅可提问。
- **触发规则**：私聊仅白名单（`bot.whitelist`）触发；群聊任何人 @ 机器人即可（真 at 或文本 @ 均可，光 @ 不说话也会回应）。
- **人设**：`sandbox/.pi/SYSTEM.md`（企鹅主任），改动后下一条消息自动生效。首次使用从 `sandbox/.pi/SYSTEM.example.md` 复制并改成你自己的。
- **群管-反刷屏**（`src/antispam.ts`，机械判定不经 LLM）：同群相同文本 90 秒内出现 ≥3 次（含单人连发与多人跟风）→ 自动撤回除最先一条外的全部消息，并输出"本群禁止刷屏行为"。院长消息参与计数但豁免撤回。注意 QQ 平台限制：管理员无法撤回其他管理员/群主的消息（撤回失败会记日志）；要完全覆盖需 bot 为群主。参数在 `config.json` 的 `antispam`。
- **课表查询**（所有人可用，`schedule/zf.ts`）：发"课表/今天课表/明天课表/后天课表/本周课表"，直答"节次+课程+教室+老师+开始时间"。只读查询，无法经此改动任何东西；登录凭据在脱敏清单中，任何回复都不会出现。自动登录教务系统（RSA 加密，无需验证码），按周次拉取（服务端解析单双周），缓存 6 小时。配置在 `config.json` 的 `jw`。
- **旧长期记忆**（未纳入新系统保护的范围仍使用 `memory/long-term/<QQ>.jsonl`，仅院长可写）：院长说"记住X"→ pi 调 `remember` 工具永久保存；每次对话自动把本人条目附在消息前；`recall` 查、`forget` 删（删前复述确认）。每人独立档案，只注入本人的对话；记忆内容不能改变权限规则。
- **旧会话上下文**（新记忆未接管的范围）：5 分钟滚动窗口（`config.memory`）——窗口内续接同一 pi 会话（完整上下文）；过期后旧窗口惰性压缩成 ≤300 字摘要带入新窗口（只在实际有人回来时才花这次调用，窗口过小 <1KB 不压缩），归档 24h 后清理。**私聊按用户隔离，群聊按群共享上下文**：同群所有成员的提问与回复写入同一会话（`memory/group-<群号>.jsonl`），彼此可见；正常模式与娱乐模式回复时都会把群里最近的聊天记录（`memory/group-chat/`）附进提示词，bot 能看到大家正在聊什么（娱乐模式被 @ 接话和主动插话都带，只 @ 不说话时也有据可依）。同一上下文（私聊=用户、群聊=群）串行处理。
- 超长回复自动分片；群聊回复以「聊天记录」卡片发送（send_forward_msg，单条）；单次处理超时 240 秒自动终止。
- **统一走模型**：模型管理、娱乐模式开关、记忆开关、课表查询等对话都进入 pi，由模型按需调用 `model_manage` / `mode_manage` / `memory_manage` / `schedule_query` 等工具；桥接只保留触发门控、反刷屏和工具执行，不再做关键词拦截或本地代答。
- **娱乐模式表情包**（`src/stickers.ts` + `src/gate.ts`，仅娱乐模式群）：院长说「开启/关闭娱乐模式」控制某个群（由模型调用 `mode_manage` 工具，桥接不再做关键词拦截）；开启后 bot 会像普通群友一样主动接话（概率门控）并按协议回图。图片放 `stickers/`，清单写 `stickers/manifest.json`——每条填 `id`、`file`、`name`、`description`（模型只看到 id、名称和场景描述，按聊天意图挑 ID，桥接校验后发送原文件字节）。支持 PNG、JPG/JPEG 和 GIF（单文件 ≤ 8 MiB）；新增素材跑 `npm run stickers:sync`——扫描 `stickers/` 把未登记的图片自动补进清单（名称取文件名、描述留空可后补），并列出运行时会被静默忽略的坏条目；或跑 `npm run stickers:watch` / 双击仓库根目录的 `sync-stickers.bat` 常驻监听，图片放进 `stickers/` 就自动登记。清单每次接话重新读取，改清单、换素材无需重启；同一个 ID 10 分钟内不重复，刚发过图 60 秒内不再连发；文件缺失、清单损坏或图片被拒时自动回退纯文字。

### 娱乐模式：看图与表情理解

- 娱乐群**新收到的图片**会在后台生成视觉摘要，再按消息 ID、发送者合并进上下文；先发图，再 `@qb 怎么样` 也可以看到摘要。识别与回话分开，不会因为识别完成就自动发言，原有概率门控不变。提问时最多等近期本人图片 12 秒，超时如实标为待识别，后台继续处理。
- 当前消息或显式引用里的图片仍附原图给模型；只在下载成功后标注“附件可查看”。下载失败、队列满、超时及数量限制都有明确标记，不假装看过。图片单张最多 8 MiB，每消息最多处理 3 张；CDN 下载限定腾讯图片域名，校验格式、大小及重定向。
- QQ `face` 保留平台给出的名称（例如 `/散味儿`），没有名称则保留 ID，不猜含义。`mface` 保留名称并作为图片识别。Unicode emoji 保留原字符、重复、肤色和组合，给常见符号追加有限文字提示；未知符号保持原样。
- 表情包摘要区分**画面、配字、可能语气和不确定性**，不编造未知梗，不把梗图当作发送者真实情绪。GIF 目前只保证静态帧理解，**没有完整动画理解或多帧抽取**。
- 图片识别通过现有 pi/模型服务进行，**不是本地视觉推理，原图会发送到配置的模型服务**。摘要落在 `memory/group-chat/` 原消息对应的日志中，沿用 3 天日志清理；临时图片约 1 小时清理，群内内容哈希缓存最多 256 项、1 小时有效。关闭娱乐模式取消未完成的识别；新上下文会排除收到撤回通知的消息，但不会物理删除已有日志或旧会话副本。
- 只处理开启娱乐模式后收到的新图，**不回扫旧图**。正常/娱乐模式近期上下文双向隔离，只注入明确标记为本模式的发言；旧的未标记记录不自动注入。使用独立 `memory/mode-v2-normal-group-<群号>.jsonl` / `mode-v2-ent-group-<群号>.jsonl` 会话，不读取或摘要旧混合会话，旧文件保留不删除。

配置可选（配置变更需重启桥接，不影响 `modes.json` 的群开关）：

```json
"entertainment": {
  "replyFrequency": 0.3,
  "media": {
    "enabled": true,
    "model": "deepseek-flash"
  }
}
```

`media.enabled` 默认 `true`，设为 `false` 关闭后台识别，不影响 @/引用时直接附图；`media.model` 可填模型别名或 pi 规格，不填跟随当前对话模型。模型必须真正支持图片；仅在配置里声明 `image` 并不能保证远端支持。后台无工具、无会话，单 worker，最多排队 24 张，单次模型调用 45 秒、入队总截止 90 秒；交互优先，明确的抢占最多重试一次。

```bash
npm run selftest:media  # 合成图片、模拟模型和假 OneBot，不连接真实 QQ
npm run probe:vision   # 使用真实配置模型，只发送本地生成的几何图，不发送群聊图片
```

### 模式切换与内部协议隔离

- 每轮回复固定接收时的模式；真正切换模式后，取消该群仍在生成、排队或摘要中的旧任务。即使随后切回，旧任务也不复活。主动插话、分片发送、图片失败后的文字回退也会复核任务是否仍有效，不影响其他群或私聊；重复设置同一模式不会误取消任务。
- 已经提交给 QQ 的发送请求无法撤销，也无法保证停止切换前已执行的工具副作用。防护保证的是：切换后不再新提交旧回复、分片或回退。普通主动接话/问答在返回模型结果后都会检查这一边界。
- 正常模式明确使用普通答复，严格识别到完整内部 `{ "text": "...", "sticker": null }` 协议时只发正文，空正文用简短文字兜底，不发内部 JSON、不发素材图。如果用户明确要求 JSON/代码原文，或输出是其他业务 JSON，则保持原样。异常协议会话会移到 `memory/archive/protocol-...`，新问答不再继续或摘要这份会话。
- 自动注入的机器人历史及 `chat_digest` 工具会去掉严格内部协议，仅保留实际正文；用户消息不改写。旧记录、旧模型会话保留在本地，不在升级时删除。

```bash
npm run selftest:modes  # 模式快照、来回切换、主动插话、迟到附件/摘要、协议防漏
```

## 与本机个人助手的通信桥

主人本机还可以挂一个更全能的 AI 助手「本机个人助手」（能操作本地文件与命令，可换成你自己的）。两者通过文件信箱（`memory/bridge/`）异步通信，只有院长能触发：

- **bot → 本机个人助手**：`tell_guga` 工具（院长私聊/群里让 bot 给本机个人助手带话时调用）会直接把留言 POST 给本机个人助手本地服务的 `/api/send`（默认 `127.0.0.1:8787`），当场踢起一轮、接近即时执行；服务没起或超时才回退写入 `memory/bridge/to-guga.jsonl`，等本机个人助手下一轮读入。提交时会把「回发目标」（来源是哪个群/私聊，`group:<群号>` 或 `private:<QQ号>`）随留言一起带上。
- **本机个人助手 → bot → QQ**：本机个人助手写 `memory/bridge/to-qq.jsonl`，桥接每 3 秒轮询，通过 OneBot 真发到群或私聊。**回执**：本机个人助手处理完带话任务后，按留言里的回发目标把结果发回来源会话（仅在院长明确同意的前提下）。
- 两个文件名固定，两边扩展/桥接按同一路径约定协作；本机个人助手在线时是即时触发，离线时退化为异步留言。

## 第一次使用

- **平台**：Windows。启动脚本是 `.bat`/`.vbs`，其他系统需自行改写。
- **先准备好这些**（都要自己装/下，不在仓库里）：
  - Node ≥ 22.19：https://nodejs.org/ （或 `winget install OpenJS.NodeJS.LTS`）
  - pi：`npm i -g @earendil-works/pi-coding-agent`
  - NapCatQQ：https://github.com/NapNeko/NapCatQQ ，到 Releases 页下 `NapCat.Shell.Windows.Node.zip`（下打包好的 Shell 版，不是 clone 源码），解压即用
  - pdftotext（读 PDF 用，可选）：随 Git for Windows 安装，https://git-scm.com/download/win （或 `winget install Git.Git`）
- **把仓库里的 example 复制成正式文件，改成你自己的值**：
  - `config.example.json` → `config.json`（QQ 号、OneBot token、各模型 API key、教务账号等）
  - `start-napcat.example.bat` → `start-napcat.bat`（填 `NAPCAT_DIR` 和机器人 QQ 号）
  - `sandbox/.pi/SYSTEM.example.md` → `sandbox/.pi/SYSTEM.md`（机器人人设，按需改）
  - `pi-bot-start-bridge.example.vbs` → `pi-bot-start-bridge.vbs`（路径已自动推导，一般直接复制即可）
- 这些正式文件都已被 `.gitignore` 忽略，不会误提交。
- **想自己加功能**：每个功能一个扩展文件，放在 `sandbox/.pi/extensions/`，照现有文件改即可；桥接侧的钩子在 `src/main.ts`。

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

机器人的身份设定在 `sandbox/.pi/SYSTEM.md`，改动后下一条消息自动生效。仓库里放的是脱敏模板 `sandbox/.pi/SYSTEM.example.md`，首次使用时复制成 `SYSTEM.md` 再按需修改（`SYSTEM.md` 已被 `.gitignore` 忽略，不会进仓库）。

## 配置

- 首次使用：把 `config.example.json` 复制为 `config.json`，按里面的说明填入自己的值（QQ 号、token、API key、教务账号等）。**`config.json` 已被 .gitignore 忽略，不会进仓库。**
- 主要字段：
  - `onebot.wsUrl` / `onebot.token`：连 NapCat 的 WebSocket 地址与密钥（与 NapCat 的 `onebot11_<QQ号>.json` 中 `websocketServers[0]` 一致）
  - `bot.owner`：最高权限者 QQ 号；`bot.whitelist`：私聊白名单
  - `pi.models`：可用模型别名（如 `{"deepseek-flash": "deepseek-flash", "glm": "aliyun-maas/glm-5.3"}`）
  - `pi.tavilyKey`：Tavily 搜索 key；`pi.aliyunKey` / `pi.aliyunBaseUrl`：百炼实例（用 GLM 时需要）
  - `jw`：教务系统账号/密码/学年学期/班级/节次时间（课表功能用）
  - `antispam` / `memory`：反刷屏与旧会话窗口参数
  - `files`：附件处理参数（`maxTextChars` 单文件文本上限、`maxTotalChars` 单条消息总量、`pdftotext` 可执行文件路径）
  - `web`：联网工具参数（`maxTextChars` 单页正文上限，默认 50000，超出截断并标注全文字数）
- NapCat OneBot 网络：`<NapCat目录>\napcat\config\onebot11_<QQ号>.json`（启用正向 WS，端口与 config 一致，改后热重载）。
- 两端 token 必须一致：`config.json` 的 `onebot.token` 与 OneBot 配置里 `websocketServers[0].token` 相同。

## 依赖与环境

- **Node ≥ 22.19**（用到原生 TS 运行与 `--experimental` 特性）。
- **pi**：`npm i -g @earendil-works/pi-coding-agent`。Windows 上若 Git 不在默认路径，需在 `~/.pi/agent/settings.json` 里设 `shellPath` 指向 `bash.exe`。
- **pdftotext**（读 PDF 用）：Git for Windows 自带（`<Git安装目录>/mingw64/bin/pdftotext.exe`），桥接会从 PATH 与 Git 安装目录自动查找；找不到时 PDF 会如实回复读不了，可在 `config.json` 的 `files.pdftotext` 指定完整路径。Word/Excel/PPT 不需要外部工具。
- **NapCatQQ**（https://github.com/NapNeko/NapCatQQ）：到 Releases 页下 `NapCat.Shell.Windows.Node.zip`，解压即用；若启动报 `wrapper.node` 加载失败，从 QQ 安装包的 `Files/versions/*/resources/app/` 提取 `crypto.dll`、`ssl.dll`、`dbghelp.dll` 放入 NapCat 目录。
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
