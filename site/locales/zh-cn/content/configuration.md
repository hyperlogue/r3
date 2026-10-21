## 绝大多数工作流开箱即用，无需配置

r3 默认运行在回环地址上，无需登录，普通的 Artifact 链接可以直接打开。你可以直接在工作区中自定义字号、颜色主题和语法高亮样式。

在**设置 → 语言**中选择英语或简体中文。该偏好会保存在你的浏览器中。

若要查看当前设置，请在终端中运行 `r3 config show`。

## 核心配置项

| 配置项 | 控制内容 |
| --- | --- |
| `backendUrl` | CLI 和智能体连接的后端端点。 |
| `publicUrl` | 服务器对浏览器公开的地址；配置外部主机名时要求登录。 |
| `allowedHosts` | 额外允许访问的主机名；包含任何外部主机名时要求登录。 |
| `trustedProxies` | 受信任、可提供客户端地址的代理连接 IP；配置代理时要求登录。 |
| `requireLogin` | 设为 `true` 时，仅供本机访问的服务器也要求浏览器和 API 身份验证。对外暴露的服务器始终要求登录，并拒绝设置为 `false`。 |
| `disableLoginNotice` | 设为 `true` 时，不再显示回环服务器未启用登录的一次性浏览器提示（默认：`false`）。 |
| `archiveTtlDays` | 已归档Artifact符合清理条件的最短保留时长（默认：30 天）。 |
| `authTokenIdleDays` | 浏览器登录令牌在闲置多久后过期（默认：14 天）。 |
| `projectGrouping` | 自动 Git 远程检测（`remote`）或显式项目指定（`manual`）。 |

服务器级别的更改必须**在主机上**执行，并通过运行 `r3 server restart` 生效。（在 CLI 中更新 `backendUrl` 会立即生效）。

只有仅供本机访问的服务器才默认关闭登录：监听地址是回环地址，`publicUrl` 和 `allowedHosts` 仅包含回环地址，且未配置 `trustedProxies`。`r3 config set requireLogin true` 可在这种情况下开启登录。其他配置始终要求登录；r3 会拒绝以 `requireLogin=false` 保存或启动这些配置。`r3 config unset requireLogin` 恢复默认设置。如果设置了 `R3_REQUIRE_LOGIN`，它会优先于保存的配置，并遵守相同限制。

关闭登录后，任何能连接到回环端口的程序或本机账号都能访问整个工作区；服务器会拒绝代理转发的请求，也不会创建登录令牌或 API 密钥，因此不会因关闭登录而签发持续有效的凭据。Host/origin 检查和预览隔离仍然生效。无论使用哪种模式，发布返回的 URL 都不包含会过期的登录码。远程 CLI 后端始终需要通过 `r3 login` 授权，详见[本地与远程访问](/docs/access/)。

有关远程服务器托管和多设备设置，请参阅[本地与远程访问](/docs/access/)。
