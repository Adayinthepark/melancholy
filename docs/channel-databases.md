# Channel databases（频道数据库）

每个频道可以拥有多个独立数据库。每个数据库对应一个 **SQLite Durable Object**，
用 JSON 定义集合与字段。D1 保存数据库目录、成员权限和 Token；记录、结构版本、
历史、幂等请求和变更游标都保存在对应 DO 中。

设计参考 [Adayinthepark/tongpoo](https://github.com/Adayinthepark/tongpoo)：保留
“数据库目录 → 独立 DO → JSON 集合 → API”的结构；实现为 melancholy 原生模块，
沿用频道权限。没有复制旧项目的 Raw SQL、SQL 字符串过滤、Arrow、时序专用接口或 MCP 服务。

## 使用界面

频道顶部的 **Data** 可以：

- 创建数据库、查看数据库与集合。
- 使用 JSON 创建／更新集合结构，查询、创建、编辑、删除记录，查看记录历史。
- 给外部系统创建限定数据库的 API Token，随时撤销。
- 归档自建数据库；立即关闭 API 访问并撤销 Token。底层数据保留供运维恢复。

默认的 **Project** 数据库包含：

| 集合 | 用途 | 写入方式 |
| --- | --- | --- |
| `notes` | Markdown 项目知识 | Notes 页面、Data 页面或记录 API，读写同一份数据 |
| `files` | 频道已发布的 R2 附件索引 | 由工作区自动维护；API 可查询并下载文件 |

R2 保存文件内容。草稿上传、被删除消息的附件不会出现在 Files 集合中。
文件上传仍走现有的附件发布流程；直接插入一条 JSON 不能授予 R2 访问权限。
Issues 仍以 GitHub 为来源；Timer 的调度、执行授权与去重仍由原有系统负责。

## JSON 集合定义

```json
{
  "name": "findings",
  "description": "Research findings with source links",
  "fields": {
    "title": { "type": "string", "required": true, "maxLength": 160 },
    "status": { "type": "string", "indexed": true },
    "score": { "type": "integer", "indexed": true },
    "source": { "type": "string" },
    "metadata": { "type": "object" }
  }
}
```

这是明确限定的结构格式，**不是完整 JSON Schema 标准**。

- 字段类型：`string`、`number`、`integer`、`boolean`、`object`、`array`。
- 可选属性：`required`、`indexed`、`description`、字符串的 `maxLength`。
- 可选值以省略字段表示；不接受 `null`。对象和数组内部允许任意 JSON。
- 记录不接受未定义字段。`id/version/created_at/updated_at/created_by/updated_by`
  是系统元数据，不能用作自定义字段名。
- 集合与字段名：小写字母开头，后接小写字母、数字或下划线，最多 40 字符。
- Record ID：1–100 位字母、数字、下划线或连字符。
- `indexed: true` 在 DO SQLite 创建 JSON 字段表达式索引；只支持标量字段。
- 修改已有结构可新增可选字段、放宽限制、调整索引和描述。删除字段、改变类型、
  新增必填字段或收紧长度限制会返回 409。需要这种迁移时，创建新集合、转换并写入数据。
- 删除集合前必须清空当前记录。删除后集合名保留，不允许复用；历史不会被新集合覆盖。
- Project 内置集合结构由应用管理，但可以在 Project 中增设自定义集合。

## 身份与权限

浏览器登录会话可调用所有符合角色权限的接口；写请求必须带同源 `Origin`。
频道创建人或工作区 Owner，且仍是频道成员，才可管理数据库、结构和 API Token。
普通成员可读写记录；公共频道未加入的成员可读，加入后才可写。

外部系统使用 **Data → API access** 生成的 Token：

```http
Authorization: Bearer mdb_...
```

Token 只属于一个数据库，必须有 `read`，可增加 `write`、`schema`。
管理结构需要三项权限。Token 仅显示一次，数据库仅保存 SHA-256 哈希；
默认 90 天有效，API 可指定 1–365 天。撤销、过期、创建人停用、离开频道，
或数据库被归档后立即失效。结构操作还会检查创建人当前的频道管理权限。
Token 不能管理其他 Token，也不能创建、改名或归档数据库。

已有 Bot API Token 与 Server 的 `MELANCHOLY_API_TOKEN` 也可调用数据库接口，
继续受频道范围、Bot 成员身份、任务有效期限制；可读写记录，不能管理结构和 Token。
Cloudflare Bot 内置 `channel_database` 工具。Casual chat 可按用户权限读取跨频道数据，
不能通过这个工具修改项目数据库。

没有公开数据库 URL 或匿名读写。外部浏览器的跨域访问未开启；建议通过自己系统的后端接入。

## HTTP API

前缀：`https://YOUR_WORKSPACE/api/data/v1`。下列 `DB` 是数据库 ID，
`COLLECTION` 为集合名，`ID` 为记录 ID。所有 JSON 响应带 `Cache-Control: no-store`。

| Method | Path | 请求／用途 |
| --- | --- | --- |
| GET | `/channels/ROOM/databases` | 列出有权限访问的频道数据库，包含默认 Project |
| POST | `/channels/ROOM/databases` | `{id?:UUID,name,description?}`；管理者创建，201。传稳定 `id` 可重试 |
| GET | `/databases/DB` | 元数据、集合结构、记录数量和 API 地址 |
| PATCH | `/databases/DB` | `{version,name?,description?}`；改名或说明 |
| DELETE | `/databases/DB` | `{version}`；归档自建数据库，关闭 API |
| GET | `/databases/DB/schema` | 所有集合的 JSON 定义、版本及当前记录数量 |
| PUT | `/databases/DB/schema` | `{collections:[{definition,version}]}`；原子应用多个结构，不自动删除遗漏的集合 |
| GET | `/databases/DB/collections` | 与 GET schema 相同 |
| PUT | `/databases/DB/collections/COLLECTION` | `{definition,version}`；创建用 version=0，更新传当前版本 |
| DELETE | `/databases/DB/collections/COLLECTION?version=N` | 删除空的自定义集合 |
| GET | `/databases/DB/collections/COLLECTION/records?limit=50&cursor=...` | 按 ID 翻页 |
| POST | `/databases/DB/collections/COLLECTION/query` | JSON 条件查询、排序、翻页；只需要 read 权限 |
| GET | `/databases/DB/collections/COLLECTION/records/ID` | 读取单条当前记录 |
| POST | `/databases/DB/collections/COLLECTION/records` | `{requestId,id?,data}`；省略 id 使用 requestId |
| PUT | `/databases/DB/collections/COLLECTION/records/ID` | `{requestId,version,data}`；完整替换字段值 |
| DELETE | `/databases/DB/collections/COLLECTION/records/ID` | `{requestId,version}`；保留删除标记 |
| GET | `/databases/DB/collections/COLLECTION/records/ID/history?before=N` | 最近 50 个版本，返回 next；删除后的普通记录仍可读取历史 |
| POST | `/databases/DB/batch` | `{requestId,operations:[...]}`；跨集合原子写入 |
| GET | `/databases/DB/changes?after=0&limit=100` | 持久变更游标，包含结构变更和删除 |
| GET | `/databases/DB/collections/files/records/ID/content` | Project 附件下载；每次检查当前消息可见性 |
| GET | `/databases/DB/tokens` | Token 元数据列表，不返回 Token 值 |
| POST | `/databases/DB/tokens` | `{name,scopes:["read","write","schema"],days?:90}`；201，一次性返回 token |
| DELETE | `/databases/DB/tokens/TOKEN_ID` | 撤销 |

记录响应：

```json
{
  "id": "finding-1",
  "data": { "title": "Durable state", "status": "open" },
  "version": 1,
  "created_by": "MEMBER_ID",
  "updated_by": "MEMBER_ID",
  "created_at": 1790668800000,
  "updated_at": 1790668800000
}
```

单条写入与批量写入均返回 `{records:[...]}`；删除条目为 `{id,deleted:true,version}`。
必须传 `requestId`，同一个数据库内唯一。重试必须保留相同 requestId、操作与身份；
返回原始结果，不重复递增版本。同 ID 对应不同操作会返回 409。
记录 ID 删除后不复用。HTTP 错误结构为 `{error:"..."}`：400 输入错误、401 身份失效、
403 权限不足、404 不可见／不存在、409 版本或 ID 冲突、413 请求过大。

## 外部系统示例

在 Data 中创建数据库，并生成含 read/write/schema 的 Token。
以下环境变量由你自己的运行环境提供，避免把 Token 放进仓库或日志：

```sh
# DB_URL=https://YOUR_WORKSPACE/api/data/v1/databases/DATABASE_ID
# DATA_TOKEN=从 Data → API access 复制的 token
curl "$DB_URL/collections/findings" \
  -X PUT -H "Authorization: Bearer $DATA_TOKEN" -H 'Content-Type: application/json' \
  --data '{"version":0,"definition":{"name":"findings","description":"Research findings","fields":{"title":{"type":"string","required":true},"status":{"type":"string","indexed":true}}}}'

curl "$DB_URL/batch" \
  -H "Authorization: Bearer $DATA_TOKEN" -H 'Content-Type: application/json' \
  --data '{"requestId":"import-20260929-001","operations":[{"op":"create","collection":"findings","id":"finding-1","data":{"title":"Durable state","status":"open"}}]}'

curl "$DB_URL/collections/findings/query" \
  -H "Authorization: Bearer $DATA_TOKEN" -H 'Content-Type: application/json' \
  --data '{"filters":[{"field":"status","op":"eq","value":"open"}],"orderBy":"updated_at","direction":"desc","limit":50}'
```

查询使用 `filters` 数组（AND），支持 `eq/ne/gt/gte/lt/lte`。字段为顶层标量字段或
`id/version/created_at/updated_at`。`orderBy` 默认 id，direction 默认 asc。
返回 `{records,next}`，把 next 原样作为下一次 query 的 cursor；筛选和排序必须相同。
排序值相同时按 ID 决定顺序，缺省字段也能正常分页。它是实时分页，不是数据库快照。

批量操作：

```json
{
  "requestId": "review-20260929-002",
  "operations": [
    { "op": "update", "collection": "findings", "id": "finding-1", "version": 1,
      "data": { "title": "Durable state", "status": "reviewed" } },
    { "op": "create", "collection": "findings", "id": "finding-2",
      "data": { "title": "Another finding", "status": "open" } }
  ]
}
```

任意一项校验或版本检查失败，整批回滚，包括记录、历史、变更游标和幂等请求结果。

## 增量同步

```sh
curl "$DB_URL/changes?after=0&limit=100" -H "Authorization: Bearer $DATA_TOKEN"
```

返回 `{changes,next,hasMore}`。每个事件包含单调递增的 `seq`、`collection`、
`record_id`（结构事件为 null）、`operation`、`version`、`actor`、`at`。
先成功处理一页，再持久化 next，继续用 `after=next` 拉取。
重复消费用 seq 去重；在外部系统导入时用稳定 requestId 防止回写重复。

事件不包含正文；普通记录可通过 GET 取最新值，或 history 读取对应版本。
Files 不暴露历史快照，避免通过历史读到已删除附件的元数据。
本版提供游标轮询，没有主动向任意 URL 投递的 outbound webhook。

## 迁移、恢复与限制

部署时先应用 D1 migration `0011_channel_databases.sql`，随后部署包含 v4 SQLite DO
迁移与 `CHANNEL_DATABASES` 绑定的 Worker。

- 旧 Notes 在首次访问频道 Project 数据库时逐批导入，保留 ID、版本、作者、时间和
  Markdown 来源链接。导入可重试，删除过的 Note 不会在重启后复活。
- 导入完成后所有 Notes 路径仅写 DO；D1 `channel_notes` 保留为迁移前档案，
  **不是实时副本**。不要回滚到仅使用旧表的代码，否则会看不到之后的编辑。
- Files 通过 D1 trigger 与附件发布／删除事务一起记录事件；Project DO 在读取前按
  持久游标重放。一次最多处理 10,000 个事件，超过时返回 503，重试继续。
- 私聊附件仍使用原来的路径，频道数据库不会把 DM 文件暴露给频道。
- 数据库归档后不删除 DO 存储。需要运维恢复时先备份、检查目录和权限，再恢复
  D1 目录记录；旧 Token 不恢复。UI 没有恢复或永久清空按钮。
- DO 的持久存储在实例休眠或重启后保留；Cloudflare 还提供 SQLite DO 的
  [PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#point-in-time-recovery-pitr-api)。
  应独立备份 D1 目录、R2 和每个 DO，D1 export 不会包含 DO 记录。

当前边界：每频道 20 个数据库（含 Project）、每库 32 个集合、每集合 32 字段、
每条 JSON 记录 256,000 bytes、每请求 1 MiB、每批 100 个操作、查询每页 100 条、
每库 30 个 Token。平台 SQLite DO 的每库容量限制仍适用。
Notes UI 展示最近 200 篇，其余可通过 Data/API 翻页。
历史、幂等结果、变更日志和附件事件目前不自动清理，需监控存储用量。
自部署按自己的 Cloudflare 资源计费，无需额外数据库服务或 Server。
