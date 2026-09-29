# Casual chat 与项目频道

Casual chat 用来随意讨论、了解工作区近况、探索新想法；频道保存一项持续工作的讨论、资料和执行记录。

## 启用大管家

进入 **Workspace settings → Casual chat**，开启功能并选择 **Reasoning agent**。

- 选择标记为 **Server** 的 Bot，会使用对应服务器的现有 CLI、模型和环境。
- 选择 **Cloudflare · Pi** 的 Bot，会使用该 Bot 配置的模型 Key 和云端工作区。
- 如果列表为空，先在 **Servers** 连接服务器，或在 **Bots** 创建 Cloudflare Bot。
- 功能默认关闭。启用后，每位成员的侧栏都会出现 **Casual chat**，首次打开时创建自己的私有对话。
- 每个成员、每个执行 Bot 的对话与 agent session 独立。更换 Bot 会打开另一份历史；旧历史保留在侧栏，重新指定原 Bot 后可以继续。

大管家可以读取当前成员有权限访问的频道，搜索讨论、读取近期 Notes 和文件索引；可以查看关联仓库、Workers、定时任务数量、集成配置和相关 Server 的在线状态。管理员可以看到全部集成的元数据，普通成员只看到其可访问频道关联的集成。其他成员的私有频道和私聊不会被加入上下文，管理员身份也不绕过频道阅读权限。

对 GitHub / Cloudflare，大管家可以按需检查凭据验证接口，报告时间和结果。验证成功不等于拥有全部仓库或 Worker 操作权限。模型 Key 和自定义凭据只报告“已配置”，不会为了检查状态发起付费模型调用。任何状态接口都不返回密钥值。

Server 收到当前工作区概览，并可使用本次任务专用的 API Token 查询频道或提交建议；Cloudflare Bot 有对应的 Pi 工具。普通 Bot API Token 不能调用这些跨频道工具。停用 Casual chat、换执行 Bot 或撤销成员访问后，会拒绝后续数据访问与新任务。已经传给模型或服务器的内容无法被撤回；服务器本地文件与工具能力仍由服务器操作员管理。

## 从想法变成频道

Agent 可以提交包含频道名称、主题和 brief 的建议。对话上方会出现 **Review channel**；也可以随时点 **Create channel from idea**。

创建界面允许修改名称、可见性和 brief。由 Casual chat 发起的创建默认使用私有频道，最终由用户选择。确认后，brief 成为频道第一篇 **Project brief** Note。Agent 提交建议本身不会新建频道，也不会创建外部资源。

## 关联 GitHub 与 Workers

创建频道时展开 **GitHub repository & Cloudflare Workers**：

- **Link existing repository**：选择 GitHub 连接，输入 `owner/repository`。
- **Create a repository**：选择 GitHub 连接，填写仓库名称；可填写组织名，不填则使用该连接对应的 GitHub 用户。默认创建私有仓库并初始化。连接需要创建仓库的权限。如果相同 owner/name 已存在，保存会关联它，以支持失败后的重试。
- **Cloudflare Workers**：选择 Cloudflare 连接，从账号下的 Workers 中多选。可切换账号继续选择。

只有工作区管理员可以建立资源关联。Cloudflare Token 至少需要相关账号的 **Workers Scripts: Read** 来列出和验证 Worker。GitHub Token 创建仓库所需权限取决于 Token 类型和目标账号／组织规则；仅能读取现有仓库的 Token 不足以创建仓库。参考 [凭据指南](credentials.md)。

资源可在频道右上角的仓库按钮，或 **Issues → Repositories & connections** 中继续管理。一个频道可以关联多个仓库和多个 Worker。Worker 链接会打开 Cloudflare 控制台。关联记录不会部署或修改 Worker，也不会自动把凭据交给 agent；要允许 agent 使用凭据，仍需在频道 connections 中显式启用。

如果频道已创建，但某个外部资源关联失败，界面保留频道 ID，可修正配置后再次保存，不会另建一个频道。关闭弹窗后，也可以在该频道继续关联。

## 五个频道标签

| 标签       | 用途                                                                            |
| ---------- | ------------------------------------------------------------------------------- |
| **Chat**   | 原有消息、线程、文件附件与 agent 执行记录                                       |
| **Notes**  | Markdown 项目资料；支持新增、编辑、预览和删除，显示最近编辑者与时间             |
| **Files**  | 此频道已经分享的 R2 文件索引、下载、上传和来源消息                              |
| **Issues** | 直接读取与修改关联 GitHub 仓库的 Issues、评论、标签和受理人，也可以开启处理线程 |
| **Timer**  | 安排 agent 稍后或周期性执行任务，查看最近一次执行线程                           |

消息菜单中的 **Save to Notes** 会保存该条消息的文本和来源链接。Notes 编辑使用版本号，其他人或 agent 已更新的内容不会被旧版本直接覆盖；发生冲突后，保留当前输入并提示重新加载。

Chat 草稿及已打开标签内的编辑状态在同一频道切换标签时保留；切换频道或刷新网页前请保存 Notes。频道成员可以编辑 Notes；未加入的公共频道只能阅读。Agent 可以读取当前频道 Notes，并按用户要求保存已确认的发现。

Files 索引频道消息关联的 R2 附件，不扫描整个 bucket。草稿附件、已删除消息的文件、头像以及其他频道的文件不会混在一起。直接在 Files 上传的文件同时成为一条频道消息，仍遵循现有 10 MB 文件上限与频道下载权限。云端 agent 私有文件系统中的文件需要交付为附件后才会出现在 Files。

## 定时任务

在 **Timer → New timer** 设置名称、指令、执行 agent 和首次运行时间。Agent 必须已经加入该频道；成员可以使用管理员已加入频道的 agent。

当前界面提供：单次、每小时、每 24 小时、每 7 天。首次时间按浏览器本地时区输入，数据库保存 UTC 时间戳。重复规则是固定时长，因此夏令时切换不会自动保持相同本地钟点。这一版不是完整 Cron 表达式编辑器。

后台复用每分钟执行的 Cloudflare Cron Trigger。每次到期任务会：

1. 验证创建者和执行 Bot 仍活跃且属于频道。
2. 在 D1 事务内记录唯一的任务发生时间，创建根消息、独立线程和 agent 请求。
3. 使用现有 Server / Cloudflare 派发、恢复、停止和结果投影流程。
4. 下一次执行使用新线程，不复用上次模型 session；频道 Notes 和关联资源仍可读取。

重复 Cron 触发不会重复入队。同一定时任务的上一轮未结束时不启动下一轮；错过的多个时间点会合并为一次补跑，然后跳到未来的时间点。执行开始也受 Server 在线情况、agent 队列和 Cloudflare 调度影响，不保证精确到秒。

**Pause** 和 **Remove timer** 只影响后续触发，已经入队或运行的任务请在对应线程停止。任务历史消息保留。创建者失去频道权限、账号停用或 Bot 被移除时，调度暂停并显示原因；已排队任务在派发前也重新验证权限。只有创建者或工作区管理员可以修改该定时任务。

定时执行会使用所选 Server 的模型账户或 Cloudflare Bot 的模型 Key，产生正常的模型与运行资源费用。

## 自部署升级

备份 D1 后应用 `0010_channel_workspace.sql`，再部署新的 Worker。此迁移新增配置、Notes、Worker 关联、建议和 Timer 表，不删除原有会话或改变其 agent session ID。无需新建 R2 bucket 或增加 Cron Trigger；保留现有每分钟的 Cron 配置。

## Channel Data

频道现有 **Data** 标签。默认 Project 数据库的 notes 集合与 Notes 页面共享数据，
files 集合维护已发布 R2 附件索引。也可创建多个独立数据库、定义 JSON 集合，
并使用限权 API Token 接入外部系统。参见[频道数据库与完整 API](channel-databases.md)。

## 编辑与布局

- 频道标题和 Chat / Notes / Files / Issues / Timer / Data 在桌面共用一条顶栏；手机将标签放到可横向滚动的一行。
- 账户头像、名字与箭头是同一个下拉入口，包含 Profile、Workspace 和 Sign out。
- 桌面线程的分隔线支持拖动，也可以聚焦后用方向键调整；宽度保存在当前浏览器。手机仍使用覆盖主聊天区域的线程。
- 内容切换使用短淡入淡出，保留标签中的草稿和编辑器；遵循系统的减少动态效果设置。
- Timer 使用日历选日期、时间输入框选时刻，按浏览器本地时区解释。

### Notes 编辑器选择

Notes 使用按需加载的 [CodeMirror 6](https://codemirror.net/docs/guide/) Markdown 编辑器，提供语法高亮、格式工具栏、撤销／重做、字符计数和独立预览。编辑和预览之间切换不会清空撤销历史。内容仍是原始 Markdown，现有 API、版本冲突保护、来源链接和数据库记录保持兼容。

比较过 [Tiptap](https://tiptap.dev/docs/editor/getting-started/overview) 与 [Lexical](https://lexical.dev/docs/intro)：Tiptap 的 ProseMirror 扩展适合完整富文本编辑；Lexical 的核心模块化，但富文本与 Markdown 之间仍需导入导出规则。CodeMirror 直接编辑文本，只接入 Markdown、历史和快捷键模块，适合当前 Notes 的需要。这里没有提供所见即所得编辑；预览显示 Markdown 的最终效果。编辑器通过独立 chunk 加载，普通聊天不需要下载它。

### Bot 头像

管理员进入 **Workspace settings → Bots → Avatar**，可上传、预览、保存或移除头像，适用于 Server、Cloudflare 和 API Bot。支持 PNG、JPEG、WebP，最大 2 MB；未设置或加载失败时显示名称缩写。所有展示使用 shadcn Avatar。

头像存于私有 R2，并经登录后的 API 读取。修改接口为 `POST /api/chat/bots/:id/avatar`（请求体为图片、Content-Type 为图片类型），移除使用 `DELETE`。只有工作区管理员可以修改活跃 Bot 的头像，普通成员和 Bot Token 无此权限。

## Agent 交付与交互

Server 任务现在会把交付目录里的 Markdown 存为频道 Notes，将图片、PDF、CSV 等
文件存入私有 R2，并在聊天回复中展示文档／下载卡片。点击文档可以直接阅读，之后
在 Notes 中编辑；Files 和 Data 共享文件索引。私聊没有频道 Notes，Markdown 以
文件交付。此功能适用于升级 connector 后的新任务；不会扫描或补传历史服务器文件。

Agent 的说明、工具动作和后续回复按照实际执行顺序混排；点击单个动作可以展开
详情。运行中的原生确认和提问使用 Questionnaire，支持单选、多选及自由回答。
只有本次任务的发起者或有频道权限的工作区管理员可以回答。提交会回到原来的
Codex／Claude 进程；重复提交被拒绝，停止任务或任务超时后提问失效。刷新页面及
网络重连会保留待回答状态；Server 进程重启仍将当前任务标记为中断。

部署者需要同步升级并重启 Server connector；服务器本地的 sandbox、permission 和
approval 设置继续生效。更多交付目录、限制和协议说明见
[connector 文档](../packages/connector/README.md#deliveries-and-interactive-tasks-05)。

## Inbox 与操作详情

侧栏 **Inbox** 汇总已加入频道、私聊、群聊及线程里的消息：

- **Unread**：尚未阅读的消息，可逐条标为已读或将当前快照全部标为已读。
- **Mentions**：所有提及自己的消息，保留已读记录并标注未读状态；此处的全部已读仅处理提及。
- **Open conversation**：打开原线程并高亮对应消息；较早的回复加载附近上下文，可点击 **Back to latest messages** 返回最新回复。

聊天消息在窗口处于前台、内容进入可见区域并短暂停留后才标记已读。打开 Notes、浏览 Inbox 预览或查看频道时未打开的线程，不会被顺带标为已读。同一成员的已读状态跨设备保存并实时同步；频道权限变化后，不再展示失去访问权限的消息。

Agent 的连续工具步骤显示为一组轻微重叠的小圆点，与前后的 AI 回复保持顺序。每个点对应一个操作：低饱和绿色表示成功、红色表示失败、蓝色轻柔闪烁表示正在执行，排队或停止的操作使用灰色。悬停或键盘聚焦可查看数量与状态；点击整组弹出 **Action details**，展开某一步可查看完整命令和输出。状态实时更新，深色主题使用相应配色，系统开启“减少动态效果”时蓝点保持静止。文件交付和需要回答的确认表单仍直接显示在对话中。

发送后，输入框上方会立即显示 **Sending message…**；服务端收到任务后显示对应 Agent 名称及 **Queued… / Waiting to start… / Working… / Waiting for input**。排队状态从消息被接受时开始，涵盖准备上下文及等待上一项任务的时间。执行状态保持在输入框上方，收起操作详情、滚动聊天或刷新后仍可查看；完成后自动收起，失败原因保留在消息中。频道中尚未打开的任务线程也会显示状态。**Stop** 只停止对应任务，不会误停随后排队的新任务。在线程中未触发任何 Agent 时，发送后提示使用 @ 或开启 Auto trigger。

自部署升级需先备份 D1 并应用 `0014_agent_request_progress.sql`，再部署 Worker。迁移只增加任务请求与回复之间的关联，保留现有会话；无需升级 connector。

Markdown 附件可直接点击打开阅读弹层，支持标题、表格、列表和代码块，并保留 **Download original**。频道聊天、私聊、Casual chat 和 Files 使用同一预览；已有附件同样适用。频道 Notes 交付物继续打开对应文档。预览上限为 1 MiB，超过后可下载原文件阅读；每次打开都会重新检查文件访问权限。
