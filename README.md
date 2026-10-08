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
- **旧会话上下文**（新记忆未接管的范围）：5 分钟滚动窗口（`config.memory`）——窗口内续接同一 pi 会话（完整上下文）；过期后旧窗口惰性压缩成 ≤300 字摘要带入新窗口（只在实际有人回来时才花这次调用，窗口过小 <1KB 不压缩），归档 24h 后清理。**私聊按用户隔离，群聊按群共享上下文**：同群所有成员的提问与回复写入同一会话（`memory/group-<群号>.jsonl`），彼此可见；正常模式下回复时还会把群里最近的聊天记录（`memory/group-chat/`）附进提示词，bot 能看到大家正在聊什么。同一上下文（私聊=用户、群聊=群）串行处理。
- 超长回复自动分片；群聊回复以「聊天记录」卡片发送（send_forward_msg，单条）；单次处理超时 240 秒自动终止。

## 自动记忆与知识沉淀（可选，默认关闭）

新系统使用 `memory/knowledge.sqlite`，不需要另装数据库服务。仅处理**正常模式下 @ 机器人发起的群问答**和已授权白名单私聊。普通群聊、娱乐模式及主动插话不采集、不检索新记忆。

### 启用

1. 在 `config.json` 添加 `knowledge`，或参考 `config.example.json`；设置 `enabled: true`，填入允许启用的群号和私聊 QQ。所有 ID 都必须是字符串，`privateUsers` 必须是 `bot.whitelist` 的子集。例如（号码为合成示例，需替换）：

   ```json
   "knowledge": {
     "enabled": true,
     "groups": ["123456789"],
     "privateUsers": ["234567890"],
     "automatic": true
   }
   ```

2. 配置变更需要重启桥接；**仅填配置不会自动开始采集**。
3. 群里由 `bot.owner` 发送 `@机器人 开启记忆`；私聊由对应用户发送 `开启记忆`。机器人告知范围及第三方模型处理，然后记录启用起点。

各群和各用户私聊独立；同一个人在不同范围的资料也不合并。同群公共知识可共享，个人背景、偏好和进度按主体隔离。未接管范围保留旧会话行为，但启用配置中的保护范围不能再通过旧群日志/旧记忆工具读写；需要对应的开启命令才能使用新记忆。新系统接管后的范围即使关闭，也不会回退读取旧 session/摘要。

已有 `remember` 长期记忆会在对应私聊开启时一次性接管，原文件只读保留，标为 `legacy_unverified`（未经重新核实）；不自动进入群，不因重启/删除再次导入。普通旧条目即使没有 `pinned` 字段也能处理。旧聊天日志、旧 session 和旧摘要不回扫。

### 日常使用与管理

- `@机器人 我会一点 Python，每天能学半小时`：后台尝试提炼本人背景，不必额外说“记住”。
- `@机器人 就用 QQbot 练手，先学 SQLite`：明确采纳可记录；建议、否定完成和猜测不会当成事实。
- `@机器人 记忆状态`：查看本范围开关及本人可见的记忆状态。
- `记住……`：明确保存，结果可能是已激活或待确认候选，以返回状态为准。
- `更正 <ki_条目ID> ……` / `删除 <ki_条目ID>`：明确更新或忘记。先查询取得 ID，避免误删；删除可能同时清除关联来源及依赖同一来源的其他条目。
- `关闭记忆`：停止本范围采集、提炼和历史注入，不删除已有条目；群限 owner。
- `退出记忆`：停止本人在当前范围的采集，并**清除本人来源、条目和历史版本**。
- `恢复记忆`：从恢复时刻继续，不恢复已删除内容、不补录停用消息。

群内上述命令均须 @；私聊不用。关闭/恢复不会改变其他群或私聊的状态。

### 自动提炼与质量边界

默认每 10 分钟检查新交互，明确进展等信号可以合并后提前检查；模型调用有范围内预算，后台让路正常问答。回复用于理解上下文，**机器人说过不等于事实已验证**。

第一版先针对文字交互；附件和网页仍可用于当前回答，但其正文暂不自动进入知识库。本人明确、可逐字对照的低敏背景/偏好可自动激活；技术经验通常先为候选，明确本人实测、有适用条件并愿意本群公开时才成为群公共知识。候选不默认注入。否定、推测、广告及缺证据内容不会因模型自评高分而升级。已有条目的更正要求明确 ID；复杂事项自动归并和到期判断暂不提供。

原文默认保留 7 天，待确认候选默认 14 天；有效知识保留最少必要证据。收到平台撤回通知后使来源和关联知识失效，缺失通知时无法保证自动同步。删除是数据库逻辑/索引清理，不承诺物理介质不可恢复；已有 QQ 消息不会随库内删除消失。

聊天提炼可能发送到配置的模型服务，不是纯本地推理。敏感检测可能漏判，请勿发送密钥或证件；SQLite 默认未加密，数据库、WAL、备份均应按私密文件管理。首次使用建议先启用自己的私聊验证，再启用群。

### 本地回归

```bash
npm run selftest:memory
```

使用临时 SQLite、合成旧记忆和模拟模型/子进程，验证权限隔离、接管、检索、并发、删除与恢复；另用假的 OneBot WebSocket 服务和临时配置运行真实桥接入口，不连接 QQ 或真实模型服务。当前测试环境为 Node 24.15.0。详情见 [设计与实现说明](docs/memory-design.md)。

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
  - `knowledge`：新自动记忆的允许范围、提炼频率、预算与保留期限；默认关闭，配置后仍需在对应范围发送开启命令
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
