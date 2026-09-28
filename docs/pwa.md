# 安装 PWA 与 Web Push 通知

melancholy 可以安装为 PWA。每个自部署工作区直接向浏览器的推送服务发送通知，不需要官方中转服务器、App Store 上架或 Apple Developer 账号。

## 在设备上使用

**iPhone / iPad** 需要 iOS / iPadOS **16.4 或以上**：

1. 用 Safari 打开工作区，例如 `https://async.love`。
2. 点 **分享 → 添加到主屏幕**。
3. 从主屏幕打开安装后的 App，登录工作区。
4. 打开左下角个人菜单 → **Profile settings**，找到 **Notifications on this device**，点 **Enable notifications**，允许系统通知。
5. 点 **Send test notification**。可以切到后台或锁屏，检查通知中心；系统的专注模式可能隐藏横幅。

普通 Safari 标签页中的 iPhone 网页不能代替主屏幕安装。通知权限只能由用户主动点击授权，页面不会在打开时弹出权限请求。

**电脑 / Android**：在支持 PWA 的浏览器地址栏或菜单中选择安装；浏览器提供安装事件时，Profile settings 也会显示 **Install app** 按钮。Chrome、Firefox 和支持 Web Push 的 Safari 可以使用通知；安装入口依浏览器而异。

通知按浏览器设备开启。退出登录会撤销本次登录绑定的通知；登录到期后，也需要重新登录并再次启用。**Disable notifications** 会删除服务端订阅并取消浏览器订阅。

## 通知范围

- 私信和群聊中其他人的新消息。
- 频道里对你的 @ 提及。
- 你发起或参与过的线程中新回复。
- 上述会话中 agent 任务完成、失败或停止；流式输出不会逐段通知。

普通消息在投递前已经被标记为已读，会跳过；正在查看页面时也可能先收到通知再更新已读。Agent 结果单独通知，不会因为已看过任务的运行占位就漏掉完成提醒。

通知默认只显示工作区名称和“新消息／任务完成”等状态，不含正文、prompt、代码或凭据。点击后直接向自己的工作区读取内容并重新验证权限。通知服务仍会看到端点、投递时间和网络元数据。

## 自部署配置

需要 HTTPS（本机 localhost 仅用于开发）。当前支持 Apple `*.push.apple.com`、Google `fcm.googleapis.com`、Mozilla `*.push.services.mozilla.com` 推送端点。端点有明确白名单，客户端不能让 Worker 请求任意地址，重定向不会跟随。

也支持 Chromium 非稳定渠道使用的 `jmt17.google.com/fcm/send/`；依据 [Chromium 官方端点定义](https://github.com/chromium/chromium/blob/main/components/push_messaging/push_messaging_constants.cc) 单独限定主机和路径。

1. 应用数据库迁移，包括 `0008_web_push.sql`：

   ```sh
   npm run db:remote
   ```

2. 为**自己的工作区**生成一组 VAPID 密钥，并直接交给 Wrangler 存为 Worker secrets。用自己的 HTTPS 域名或有效 `mailto:` 联系方式作为参数：

   ```sh
   node scripts/generate-push-keys.mjs https://your-workspace.example | npx wrangler secret bulk
   ```

   生成器输出 `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`。不要提交私钥，也不要在每次部署时重新生成。公钥会提供给已登录浏览器，私钥只留在 Workers Secret。更换密钥后，各设备需要重新启用通知。

3. 运行 `npm run deploy`。保留 Wrangler 中现有的每分钟 Cron，用来恢复临时失败的投递。
4. 在已安装的 App 中登录、开启通知，发送测试通知。

本地开发可以将单独生成的一组测试密钥放入已忽略的 `.dev.vars`。不要使用生产私钥。缺少密钥时聊天仍可使用，设置会显示通知尚未配置。

## 投递与离线行为

通知记录与消息／agent 最终结果在同一个 D1 batch 中提交。请求结束后立即尝试投递；Cron 恢复遗漏或临时失败的记录。发送前再次检查用户状态、频道成员关系、登录有效期、消息删除状态及已读位置。404 / 410 会移除失效订阅；临时错误按退避策略重试，最多六次。超过一天的通知不再投递，投递记录保留七天后清理。

并发投递使用数据库租约，每个订阅与消息组合只入队一次。服务端在浏览器接受请求后崩溃等不确定情况，仍可能发生重复投递；固定 notification tag 会合并同一事件。Web Push 本身不保证送达，App 打开后仍通过聊天 API 同步消息。

Service Worker **只缓存公开的离线提示页和图标**。不缓存登录后的 HTML、API、消息、附件或凭据。离线时会显示重连页面；不支持离线发送或离线浏览聊天。网络恢复后重试。

## 排查

- **iPhone 上没有开启按钮／按钮不可点**：更新系统，从“添加到主屏幕”安装后的 App 打开，而非普通浏览器标签。
- **系统拒绝过权限**：到系统／浏览器通知设置重新允许，然后重开 Profile settings。
- **测试显示 accepted，但没有横幅**：accepted 仅表示浏览器推送服务接受请求；检查系统通知中心、专注模式、浏览器后台运行策略和网络。
- **登录后不再收到**：登录会话过期、退出、浏览器清理站点数据或更换 VAPID 密钥后，重新开启通知。
- **某个频道没有通知**：需要加入频道，并满足私信、提及或参与线程的规则；普通频道广播不会给所有人推送。
- **提示不支持的推送服务**：该浏览器使用了尚未列入白名单的服务商，需要在核对官方端点后扩展服务端白名单。
- **更换域名**：PWA、权限和订阅属于原域名；在新域名重新安装并授权。

自动化覆盖服务端加密、权限、撤销、重复／失败重试和浏览器 Service Worker 展示；iOS 锁屏、专注模式和真实网络送达仍需在真实设备上验证。

## 官方资料

- [WebKit：Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [MDN：Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [Cloudflare：Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [RFC 8291：Web Push encryption](https://www.rfc-editor.org/rfc/rfc8291)
- [RFC 8292：VAPID](https://www.rfc-editor.org/rfc/rfc8292)
