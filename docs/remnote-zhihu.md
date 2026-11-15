# RemNote 知乎文章定时发布

将配置指定的 RemNote Document 直属第一层母节点中行首单个 `%` 标记的节点及其完整物理子树发布为一篇知乎文章。标记母节点自身的可见文字作为文章标题，其下完整物理子树作为正文。用固定 Rem ID 绑定真实 Document，同一 Document 改名不改变发布范围，也不匹配同名普通节点。按直属母节点顺序处理，不进入未标记母节点内部查找 `%`，正文中以 `%` 开头的节点保留为正文，不作为独立稿件。不附带父项或兄弟项，不摘要、改写或添加话题。母节点 `%%` 暂停该稿件；「已发布」子树完全排除。

配置 `publishedTagRemId` 后，同一次扫描还会按该 Document 的精确 Rem ID 查询直接使用它作 tag 的节点。外部母节点必须同时具有这个 tag 和行首单个 `%`；只有 tag 时保留为待写内容，只有 `%` 时不扩展到无关位置。母节点自身作为标题，完整物理子树作为正文；支持其他 Document 内及知识库根级的位置。按原 Document 内容优先、外部节点 ID 稳定排序并入同一队列，共享原时段、锁和去重回执。Document 内的同一节点即使也带 tag，仍只按原 Document 流程处理一次；嵌套就绪来源、截断的 tag 搜索及异常分页会被拦截。

外部来源成功发布并核验后保留原位置：先添加 `publishedTagRemId` 指向的「已发布」tag 并回读，再移除 Document 的触发 tag 并回读，最后清除 `%` 并再次核对全文、层级、原父节点和其他 tag。两个 tag 均按节点 ID 操作，完成 tag 必须确实是该 Document 直属的「已发布」节点，不按同名 tag 猜测。中断后只继续完成 tag 切换或去标记，不再次发文；原 Document 内来源仍沿用整棵移动归档。

## 发布与恢复

北京时间每天 11:30、17:30、22:30，由 Windows 计划任务 `WakeWire - RemNote Zhihu Articles` 直接运行 `scripts/run-remnote-zhihu.ps1`，再调用本 CLI。调度模式与“一次性命令”一致，复用同一 WakeWire 仓库及本地 MCP；不使用 Codex 自动任务，不依赖模型定时唤起。每个时段最多发布一篇，其余顺延。允许当次任务在 15 分钟内启动；错过窗口不补发，不在恢复开机时集中发布。原命令工作流保留自己的时段与投递规则。

决策工作台「运行与调度」复用同一个 Windows 任务的身份、启停与运行入口，不新建定时器。工作台绑定配置中的 `reportFile` 指向本流程 `last-run.json`，用于回读最新业务状态；运行失败也写入新的错误状态与完成时间，避免旧成功回执掩盖本次失败。

发布前重新核对 Document 身份、登录账号、完整子树及原父节点。提交前将不可自动重放的记录落盘并同步到磁盘；任何超时、结果不明或没有明确文章 ID 的响应都会保留记录、停止后续发布，不能通过再次运行 CLI 重发。需要人工核对后恢复时，先找到实际公开内容；不得删除记录绕过去重。

取得 ID 后回读 `https://zhuanlan.zhihu.com/p/<id>` 对应的 API 内容，核对 ID、作者、标题、全部可见文字、列表层级、强调、链接目标和指定专栏的已接受归属，之后才将原 Rem 节点及完整子树移动到 Document 的「已发布」下。移动完成并回读后去掉根节点 `%`；保留原 Rem ID、子节点、内部引用和结构。源内容在发布后被用户修改或移动时停止归档，不覆盖用户改动。回执保留公开 URL。归档失败时再次运行只补做已验证内容的归档；已知 ID 的发布结果可以继续只读核验，结果未知则停止。

文章保留多行文字、Markdown 强调、链接和真实嵌套列表。空叶节点在正文内容组之间转为空段落分隔，不生成空项目符号；同级内容组首尾的空编辑占位不输出，内部连续空节点保留各自间隔。节点内单换行转为 `<br>`，连续换行保留相应行距，不能依赖 HTML 中会折叠的普通换行。带子树的空容器保留子树层级但不生成空项目符号。回读按可见列表深度、空段落位置、节点内换行及强调/链接所在文字位置核验，允许知乎将子列表移到父 `li` 外侧和将 `strong` 转为 `b`，不把等效 DOM 变化误判为内容变化；原始 HTML 作为文字转义，不允许脚本执行。Rem 内部引用只输出可见文字，不跟随读取引用目标。媒体、portal、未解析引用和重叠标记保留原位并报告，不以漏内容的版本发布。标题必填、禁止换行、最多 100 字；正文必填、9～100,000 字。超限时停止，不自动删减、补写或拆分。相同标题与可见正文的重复来源也会被拦截。

正文保留原稿内部的分段空行；正文结束后固定追加一个空段落，下一段为 `首次发布时间：YYYY.MM.DD HH:mm`，采用上海时区首次发布提交时刻。时间与提交回执一同落盘，后续只读核验、归档恢复不刷新该时间；旧已归档文章不自动改写。审核草稿使用 `首次发布时间：待发布`，认可后正式提交时替换为实际时间。去重只比较源正文，不受尾注时间变化影响。

RemNote 的 `$...$` 行内公式及 `$$...$$` 公式转换为知乎原生 equation 图片，LaTeX 原文经 URL 编码放入知乎公式地址，并保留于 `alt`；转义美元符号、行内代码及代码块保持文字。回读把公式模式、LaTeX 与出现位置纳入布局对照，不能因图片没有文本节点而漏检公式；超链接保留原目标地址。

文章元数据读取启用本地 MCP 的 `renderNativeMarkdown`，正文另按节点读取 `personalwebsite_richtext` 原生片段，直接转换粗体、原稿斜体、代码、超链接和公式，不经 Markdown 重解析。这样粗体末尾带空格也不会输出为字面双星号。原生格式片段参与源新鲜度校验；不支持的内容停止处理。草稿核验优先读取实际持久化的 `/draft`，不把另一接口返回的未清洗内容当作最终输入。知乎会清空公式图片的 `src`，但保留 `eeimg` 与 `alt` 并在编辑器中构建 MathJax 公式；对照比较这些原生公式数据。

编辑器最多显示五层列表。源正文有六层时，将文章一级节点输出为段落标题，其后五层输出为列表，保留完整父子关系，不把第六层并到第五层。更多层级允许先存草稿，正式发布前停止。空段落输出到列表容器外侧，再恢复后续列表深度，避免编辑器调整空段落时改变其后内容缩进。

显式 `draft ... --new-version` 会保留已知旧云端草稿，另存新稿，并将旧记录移入本机 `previousDrafts`；普通重试仍复用同一 ID。未知的创建结果始终禁止重建，正在创建的已知 ID 即使带此参数也先恢复原记录，不再创建副本。

配置 `aiGeneratedTagRemId` 后，按精确 tag ID 将对应节点及全部后代视为 AI 内容：只在最外层标记母节点前放一个紫色原生公式短标识 `AI`，不自动添加斜体。子层级不重复添加标识，嵌套同类标签也不重复；原稿已有的文字格式保持原样。整篇母节点本身带 tag 时，在正文开头放一次标识，标题保留知乎原生纯文本形式。正文和链接仍是原生文字，公式原有 LaTeX 保留。标记范围参与源内容新鲜度校验；发布前改变 AI tag 会停止发布。自定义 HTML 文字颜色会被知乎清洗，因此仅短标识使用 LaTeX 色号，不将整段正文转换为公式。

## 发布前审核与原调度合并

设置 `requirePreflight: true` 后，现有 Windows 任务保留原身份，增加每天北京时间 09:30、15:30、20:30 的草稿审核；11:30、17:30、22:30 仍每个时段最多发布一篇。统一 `tick` 命令在正式窗口调用原发布流程，其余时刻只审核下一发布时段；工作台“立即运行”在窗口外因此可用于重新审核。显式 `audit` 始终只审核，不发布或移动源节点。原 `run` 也受配置中的审核约束，不能绕过。

审核覆盖原来源边界、完整正文、原生公式、列表层级、空行、强调、超链接、标准艾特、账号及专栏条件，不进行 AI 内容评判或改写。逐篇保存真实知乎草稿并回读核验，沿用创建围栏与已知 ID，不重建未知结果。已由用户创建且待人工认可的草稿、用户编辑过的云端草稿保持原样并返回问题。通过记录绑定源版本、草稿 ID、提及身份及发布时段；发布前再次核对原稿与草稿，晚加入或被修改的稿件没有有效审核时停止发布。

`state.json` 持久保留逐篇审核记录；同一篇重新审核成功才解除原问题，撤回触发标记视为撤稿，已完成发布不再提示。`last-run.json` 的 `feedback` 仅包含审核时间、目标时段、文章标题、问题与草稿链接，不包含全文。后续正常空跑保留未解决的问题。该反馈沿用工作台同一业务绑定与日报入口，人工命令发送到该业务配置的原生 Thread；不创建另一工作流或另一传输机制。

```powershell
node dist/workflows/remnote-zhihu-cli.js audit <absolute-config.json>
node dist/workflows/remnote-zhihu-cli.js tick <absolute-config.json>
```

## 客户端与凭据

正文中的 `@姓名` 使用知乎原生 `member_mention` 节点，写入真实账号 hash 与 hovercard，并将账号身份纳入格式核验。`mentionBindings` 可保存用户已经确认的姓名与账号 ID；每次转换仍通过当前登录态核对账号。未绑定姓名先进行有限分页的用户搜索，只采用完整结果中唯一的同名账号并再次核对档案；重名、缺失、未完成的分页或身份变化会停止，不能退回普通文字。邮箱、代码、公式和原有超链接不按普通提及文本重解释。审核后及最终提交前再次比对提及身份，防止目标变化。

已核验官方 `zhihu-cli` 0.6.1 的 `capabilities`，该版本没有文章发布命令。官方发布 Skill 是另一条 OpenAPI 路线，需要独立发布凭据，不能把官方 CLI 的 Access Secret 擅自视为发布授权。

本流程调用维护中的 [BAIGUANGMEI/zhihu-cli](https://github.com/BAIGUANGMEI/zhihu-cli) 的 `ZhihuClient`（PyPI 包 `pyzhihu-cli==0.2.4`），复用其 CSRF、草稿及统一内容发布能力。纯文字文章也使用知乎当前网页编辑器的 `POST /api/v4/content/publish`，传入 `action: article`、固定草稿 ID、正文和专栏数组；不再使用该版本纯文字分支中的旧 `PUT /articles/<id>/publish`。发布前检查专栏管理权限，发布后必须回读到同一专栏的 `accepted` 归属。创建草稿取得 ID 后，在任何正文写入和公开发布前先保存该 ID；结果不明时仅按原 ID 只读核验，禁止重新提交。文章已发布但专栏尚未接受时保留文章 ID，不重复发文或提前归档。安装到本机独立 Python 环境：

```powershell
python -m venv <runtime-directory>
<runtime-python> -m pip install -r scripts/zhihu-requirements.txt
```

客户端适配器每次读取现有 Chrome Cookie 同步快照，只向 `https://www.zhihu.com` 与 `https://zhuanlan.zhihu.com` 发送匹配域名、路径和有效期的 Cookie，禁止重定向，不复制或另存 Cookie。超过 15 分钟未同步、退出账号、账号与配置不符时停止。日志不打印 Cookie、请求头、远端响应正文或源笔记正文。

## 本机配置与命令

真实 Document ID、账户 ID、Cookie 快照、Python 环境及回执只保存在本机应用数据目录，不进入 Git。配置示例：

```json
{
  "documentRemId": "<exact-document-id>",
  "documentTitle": "<display-name-only>",
  "mcpUrl": "http://127.0.0.1:<port>/mcp",
  "python": "<absolute-runtime-python>",
  "cookieSnapshot": "<existing-local-chrome-cookie-snapshot>",
  "accountId": "<verified-zhihu-account-id>",
  "columnId": "<verified-managed-column-token>",
  "seriesStartDate": "<YYYY-MM-DD-in-Shanghai>",
  "publishedTagRemId": "<exact-published-child-rem-id>",
  "aiGeneratedTagRemId": "<exact-ai-generated-tag-rem-id>"
}
```

```powershell
node dist/workflows/remnote-zhihu-cli.js check <absolute-config.json>
node dist/workflows/remnote-zhihu-cli.js scan <absolute-config.json>
node dist/workflows/remnote-zhihu-cli.js preview <absolute-config.json>
node dist/workflows/remnote-zhihu-cli.js draft <absolute-config.json> <source-rem-id>
node dist/workflows/remnote-zhihu-cli.js draft <absolute-config.json> <source-rem-id> --new-version
node dist/workflows/remnote-zhihu-cli.js approve-draft <absolute-config.json> <source-rem-id>
node dist/workflows/remnote-zhihu-cli.js publish-now <absolute-config.json> <source-rem-id>
node dist/workflows/remnote-zhihu-cli.js run <absolute-config.json>
node dist/workflows/remnote-zhihu-cli.js adopt <absolute-config.json> <source-rem-id> <published-article-id>
pwsh -NoLogo -NoProfile -File scripts/install-remnote-zhihu-task.ps1 -Config <absolute-config.json>
```

`check` 为只读扫描及登录核验；`scan` 只读计数；`preview` 将第一篇待发布内容转换为本地 HTML，不触碰知乎草稿或修改 RemNote。`draft` 使用真实知乎登录态创建并保存云端草稿，回读标题、全文与布局，返回真实编辑器链接；重复运行更新同一草稿，不另建副本。草稿结果不明时保留记录，禁止自动重建。云端已被作者修改时停止并保留改动。草稿对应的来源保留在 RemNote 原位，处于待验收状态时定时扫描跳过该来源，其余内容仍按序处理。只有用户明确认可后才执行 `approve-draft`，将该草稿恢复为可发布；此命令本身不发布。正式 `run` 复用已认可草稿的同一 ID，发布前重新核对源内容、云端内容及当日标题，不覆盖作者后续改动。

配置 `seriesStartDate` 时，云端草稿和正式文章标题追加 `（第N 篇 | day D）`。篇数按专栏已发表文章数、专栏现存标题最大篇号与本地已发表回执最大篇号的最大值递增；草稿不占正式篇数。day 按上海时区从配置起始日期计算自然日，起始日为 day 1；同一天多篇共用 day 数。实际发布前重新计算，草稿中的编号只是当时预览。标题长度包含后缀，超过 100 字即停止。

只有 `run` 会在指定窗口发布，窗口外仅恢复已有记录。`adopt` 用于用户明确指出已手动发布的文章：核对完整正文、可见布局、作者与专栏后，登记实际公开标题和 URL，将原子树归档；它不会新建或修改任何知乎文章。保存过的草稿若由用户手动发布，后续运行按同样条件核验并归档，不再发一次。已有回执冲突或对照不符时停止，不靠移除 `%` 隐藏问题。配置目录保存 `state.json`、`last-run.json`、`preview.html` 和 `preview.json`。运行使用进程排他锁，死进程残留锁可恢复，活进程持锁时拒绝并行。

转换器直接输出知乎原生的列表表示：子列表放在已闭合的父 `li` 之后。标准 HTML 的 `<li>父项<ul>子项</ul></li>` 虽然网页显示正常，但知乎编辑器导入时会在父项闭合处额外插入空段落，不能作为发布输入。API 回读中的文字和语义列表一致也不足以证明编辑器导入一致；真实验收需将编辑器渲染后的内容块逐一对照源节点，比较空行数量与位置、项目深度、文字及节点内换行。

任务以当前登录用户的 Limited 权限隐藏运行，禁止重叠实例，保留实际 Node 子流程的退出码。失败最多间隔 5 分钟重试两次；CLI 的窗口限制和已落盘回执仍约束每次重试，不会再次提交未知结果。注册任务不会立即执行发布。需 Windows 用户已登录、RemNote MCP 在线及现有 Chrome 登录态同步可用；不依赖 ChatGPT 桌面端中的 Codex 保持开启。暂停时停用该 Windows 计划任务，保留本机回执。恢复连接沿用已有 RemNote MCP 启动入口，不重启 RemNote 或用户正在使用的应用。不得通过删除未知结果记录、临时另发、扩大到其他 Document 或补发错过时段绕过限制。

## 验证

用户明确要求立即发布已经审核的草稿时，可使用 `publish-now` 指定唯一来源。它要求该来源已有状态为 `ready` 的已知云端草稿，复用原锁、提交围栏、账号和内容核验及归档，不选择其他稿件。此操作不受日常窗口限制，记录独立手动时段；普通 `run` 仍受原窗口约束。

发布后允许有限次只读等待公开可见状态，不重放发布。知乎为站外链接添加的 `link.zhihu.com/?target=...` 仅在精确主机、路径和单个安全 HTTP(S) 目标满足条件时还原为目标地址核验；不访问跳转，也不把不同目标判为相同。

```powershell
npm run typecheck
npm test
npm run lint
npm run build
<runtime-python> scripts/test_zhihu_client.py
```

隔离测试覆盖正文边界、按序单条发布、时区与窗口、重叠标记、登录失效、账号切换、源编辑、先落盘后提交、未知结果防重放、发布回读不符、移动/去标记中断恢复及独立格式样本。真实登录、目标 Document 和只读预览通过，不代表已完成一次真实发布归档；首次正式时段应根据公开 URL、回执和原 Rem 父链核验。
