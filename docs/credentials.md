# GitHub 与 Cloudflare 凭据配置

在 **Workspace settings → GitHub / Cloudflare** 保存凭据。每个页面的 **How to configure** 可以直接展开配置步骤，新增／替换表单也有文档链接。只有工作区 owner 可以管理这些凭据。

以下步骤对应当前 melancholy 实现：GitHub 使用 personal access token；Cloudflare 使用 **user API token**。保存时验证 token 是否有效，不代表它已经有每一个仓库或部署资源的操作权限。

## GitHub

1. 打开 [GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/personal-access-tokens/new)。填写名称，例如 `melancholy`，选择有效期。
2. **Resource owner** 选择仓库所属组织。管理本项目时选择 `adayinthepark`。如果看不到组织，检查自己是否为组织成员，以及组织是否允许 fine-grained tokens。
3. **Repository access → Only select repositories**，选择 `melancholy`，以及你希望 agent 操作的其他仓库。
4. 根据用途设置 **Repository permissions**：

   | 用途 | 权限 |
   | --- | --- |
   | 读取仓库信息 | Metadata: Read-only（自动包含） |
   | 创建、编辑、关闭 Issue，管理标签、负责人和评论 | Issues: Read and write |
   | 读取或提交代码 | Contents: Read and write；只读任务可用 Read-only |
   | 创建、更新 Pull Request | Pull requests: Read and write |
   | 修改 `.github/workflows` | Workflows: Read and write，仅需要时添加 |

5. 生成 token 并复制。组织启用了审批时，先等待管理员批准；pending token 不能访问组织的私有资源。
6. 打开 **Workspace settings → GitHub → Add credential**，输入名称与 token，保存。
7. 进入目标频道，打开右上角 **Repositories and issues**，在连接／仓库区域关联 `adayinthepark/melancholy`。多个仓库可以分别关联。
8. 若需让 coding agent 使用 token，在凭据的 **Channel access** 中启用目标频道。仅在网页中管理 Issue 不要求把 token 交给 agent。

网页 Issue 功能通过选中的连接调用 GitHub API。启用 agent 访问后，任务进程会收到 `GH_TOKEN` 和 `GITHUB_TOKEN`。GitHub CLI 可以使用它们；任意 `git` remote 的 SSH key 或 HTTPS credential helper **不会**自动配置。若 `git push` 报认证失败，让 agent 用 GitHub CLI 正常配置 Git 身份，或在服务器配置相应的 SSH key；不要把 token 写入 remote URL。

### GitHub 常见问题

- **保存成功，仓库仍返回 404**：GitHub 对无权限的私有仓库也会返回 404。检查 Resource owner、仓库选择、组织审批和仓库全名。
- **403 / Resource not accessible by personal access token**：检查所用 API 对应的权限、组织策略和 token 有效期。操作标签、Issue 评论等需要 Issues 写权限。
- **组织没有出现在 Resource owner**：fine-grained token 对组织成员身份和组织策略有要求；组织外部协作者等场景存在限制，见官方文档。由组织管理员协助配置，不要为了方便默认改成全仓库权限。
- **使用 classic token**：当前表单可以验证用户 PAT，但更推荐 fine-grained token；classic 的 `repo` 授权范围更大，且组织可能要求额外的 SAML SSO 授权。
- **Actions 无法运行**：token 权限不解决组织账单锁定或 Actions 被禁用的问题。

## Cloudflare

1. 打开 [Cloudflare → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens)，选择 **Create Token**。使用用户级 **API Token**，不要填 Global API Key。
2. 可以从 **Edit Cloudflare Workers** 模板开始，逐项检查权限。模板可能包含本项目暂未使用的产品，不需要照单全留。
3. 对目前使用 Workers、D1、R2、Durable Objects 和自定义域名的 melancholy，按用途配置：

   | 范围 | 权限 | 用途 |
   | --- | --- | --- |
   | Account | Workers Scripts: Edit | 发布 Worker，绑定资源，管理 Worker secrets；DO 随 Worker 发布 |
   | Account | D1: Edit | 数据库查询与迁移 |
   | Account | Workers R2 Storage: Edit | 项目的 R2 资源管理与访问 |
   | Account | Account Settings: Read | 读取账户信息 |
   | Zone | Zone: Read | 查找部署域名所属 zone |
   | Zone | Workers Routes: Edit | 管理目标域名的 Worker 路由 |
   | Zone | DNS: Edit | **仅在需要修改 DNS 记录时添加** |
   | Account | Workers Tail: Read | **仅在需要实时查看日志时添加** |

   Cloudflare 文档可能写成 Write，控制台通常显示 Edit。部署额外的 Queues、KV、Pages 等产品时，应按实际使用增加权限。

4. **Account Resources** 选择指定账户；**Zone Resources** 选择目标 zone（本工作区为 `async.love`）。避免不必要的 All accounts / All zones。部分 Account 权限覆盖该账户整个产品，不能把它理解为仅授权一个 Worker。
5. 设置合理的有效期。若启用 Client IP filtering，需要同时考虑 Cloudflare 上的网页后端验证请求，以及实际执行任务的服务器出口；只放行自己的电脑可能导致保存失败。
6. 生成并复制 token。打开 **Workspace settings → Cloudflare → Add credential**，填写名称和 token。
7. 从 Cloudflare 账户首页或域名概览的 API 区域复制 **Account ID**，一并保存。它不是 Zone ID。单账户部署也建议填写，避免 CLI 选错账户。
8. 在凭据的 **Channel access** 中启用目标频道。Agent 任务会获得 `CLOUDFLARE_API_TOKEN`，填写了 Account ID 时同时获得 `CLOUDFLARE_ACCOUNT_ID`。

**当前不支持 account-owned API tokens**：表单使用 `/user/tokens/verify` 验证用户 token。控制台 **Manage Account → API Tokens** 创建的账户级服务 token 使用不同的验证端点，请暂时使用 **My Profile → API Tokens**。这是当前应用限制，不表示 Cloudflare 不支持账户级 token。

### Cloudflare 常见问题

- **保存时提示 token 无效**：检查是否填入用户 API Token，是否过期，以及 IP 限制；Global API Key 和 account-owned token 不适用于当前表单。
- **保存成功，部署仍报权限不足**：验证端点只验证 token 是否 active。根据报错资源核对 Scripts、D1、R2、Routes 权限，以及 Account / Zone 的资源范围。
- **找不到账户／账户不匹配**：核对保存的 Account ID，以及项目 `wrangler.jsonc` 的 `account_id`。不要混用 Zone ID。
- **R2 / D1 资源找不到**：资源需要存在于目标账户。仓库中的资源 ID 属于原部署，其他自部署用户必须替换。
- **凭据改好后旧任务仍失败**：凭据在任务启动时读取。替换后发送新任务验证，已经启动的 CLI 进程不会自动换用新值。

## 频道授权、保存与轮换

- 保存后只展示名称、身份等元数据，token 不回显。凭据加密存入 D1，主密钥在 Workers Secret。
- **Channel access** 决定哪些频道的 agent 可以收到凭据；agent 必须仍在该频道，并拥有有效任务。
- 同一个频道不要启用多个会写入相同环境变量的同类凭据；任务不能同时用两个 `GH_TOKEN` 或 `CLOUDFLARE_API_TOKEN`。不同仓库权限可组合进一个授权范围合适的 GitHub token。
- **Replace** 用新 token 完整替换，保留频道授权。确认新任务可用后，再到服务商撤销旧 token。
- **Remove** 删除 melancholy 中的凭据和关联授权；若需要彻底撤销 token，也到 GitHub / Cloudflare 撤销它。
- 关闭频道授权影响后续任务；已启动的 CLI 进程仍可能持有环境变量，需要时先停止该任务。

## 官方参考

核对日期：2026-09-28。

- [GitHub：管理 personal access tokens，包括 fine-grained token 的限制](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Cloudflare：创建 API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [Cloudflare：API token 模板](https://developers.cloudflare.com/fundamentals/api/reference/template/)
- [Cloudflare：查找 Account ID 和 Zone ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)
