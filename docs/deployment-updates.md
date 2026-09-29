# 安装与更新方案

本文记录 2026-09-29 核对后的设计建议。**Deploy 按钮、应用内版本提醒和升级 PR
尚未实现**；当前安装步骤见 [README](../README.md#deploy-your-own-workspace)。

## 现状

- 仓库的 `wrangler.jsonc` 包含 async.love 的账户、域名、D1 和 R2 配置，不能直接
  当作公共安装模板。用户的配置也不应被上游更新覆盖。
- `npm run deploy` 负责构建并部署，不会自动执行 D1 迁移。
- 当前没有已发布的 GitHub Release；健康接口的 `0.5.0` 也不足以区分每次代码更新。
- Web 应用部署在用户的 Cloudflare 账户，Server connector 则运行在用户自己的机器，
  必须分别管理版本。

## 新用户：Deploy to Cloudflare + 首次设置

Cloudflare 官方按钮已支持把公开仓库复制到用户的 GitHub/GitLab，配置 Workers Builds，
并创建 D1、R2、SQLite Durable Objects 等所需资源。适合本项目现有架构。

建议用户流程：

1. 点击 README 中的 Deploy to Cloudflare。
2. 授权自己的 GitHub 和 Cloudflare，选择 Worker 名称和资源名称。
3. 配置每个安装独立的初始登录密钥和集成加密密钥。
4. 自动建库、执行迁移、构建及部署，先使用 `workers.dev` 地址。
5. 打开工作区设置用户名、密码，再选择 Server 或 Cloudflare Bot；自定义域名后配。

实施前需要完成：

- 将公共模板和实例专属配置分开，去掉 async.love 的账户、域名和资源标识。
  更新必须复用既有资源和 Durable Object 类迁移历史。
- 在部署流程执行 `wrangler d1 migrations apply DB --remote`，使用绑定名 `DB`，
  不硬编码某个安装的数据库名。vinext/Vite 构建生成的部署配置仍需正确引用这些资源。
- 用 `.dev.vars.example` 声明所需密钥，并通过 `package.json` 的
  `cloudflare.bindings` 给安装表单提供说明。示例值不能作为真实密钥使用。
  `INTEGRATIONS_KEY` 必须生成一次后持久保存，升级不得重新生成。
- 实测全新 Cloudflare 账户、首次迁移、第二次部署和密钥保留，再发布按钮。

官方文档支持部署表单填写 secrets，未承诺替应用自动安全生成所有初始密钥。
如要进一步减少手工操作，需要补充经过验证的初始化工具。

## 已部署用户：版本提醒 + 升级 PR

推荐默认流程：**管理员收到提醒 → 查看 Release → 合并升级 PR → Workers Builds 部署**。

发布端使用版本标签和 GitHub Releases，附带变更说明、迁移说明、支持的升级起点及
connector 兼容版本。构建写入 release 版本与 commit，避免只显示固定的 `0.5.0`。

每个安装的后端每天缓存检查一次公开版本信息；工作区管理员在 Settings 看到新版本
标记、当前/最新版本和更新说明。支持关闭检查，检查失败不影响聊天，不上传工作区内容。
GitHub 的 **Watch → Custom → Releases** 可以作为额外订阅渠道；它需要用户主动订阅。

升级 PR 由用户自己仓库里的工作流创建，保留其资源配置和密钥。用户确认合并后，
Workers Builds 执行检查、兼容性校验、迁移和部署。例行升级不要求用户再操作终端。
有本地代码定制或迁移冲突时，PR 应明确呈现差异，不能强行覆盖。

Deploy 按钮创建仓库副本和构建连接，**不会持续同步上游代码**。这个副本也不应被假定为
GitHub fork，因此不能把 “Sync fork” 当作所有安装都可用的更新机制。上游升级 PR
仍需项目自己实现。

数据库迁移应先增加兼容字段，再在后续版本清理旧字段，保留可用的备份/恢复点。
Worker 代码回滚不等于 D1、R2 或 Durable Object 数据回滚；有破坏性迁移的版本需要
单独的升级路径。不能承诺任意历史版本都能无条件一键升级。

Server connector 的代码仍需在对应机器更新并重启，保留原配置、state-dir、任务日志和
CLI session。应用可以提示其版本/兼容状态，但仅部署 Worker 不会升级远端进程。

## 建议交付顺序

1. 整理通用部署模板、迁移命令和独立配置，验证后发布 Deploy 按钮。
2. 建立正式 Release，加入管理员版本提醒及更新说明。
3. 增加升级 PR 工作流，与 Workers Builds 接通；再简化 connector 更新。

## 官方依据

- [Deploy to Cloudflare：资源、密钥、迁移与部署命令](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Workers Builds：Git 提交触发构建与部署](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Wrangler 自动创建资源](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)
- [GitHub Release 通知设置](https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github/setting-up-notifications/configuring-notifications)
