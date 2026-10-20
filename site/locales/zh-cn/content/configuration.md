## Most workflows need zero configuration

r3 默认运行在回环地址上，无需登录。普通 Artifact 链接无需令牌、一次性登录码或持久化的浏览器认证记录即可打开。你可以直接在工作区中自定义字号、颜色主题和语法高亮样式。

Choose **Settings → Language** for English or Simplified Chinese. The choice is
saved in your browser. Chinese interface text currently uses English placeholders.

To inspect current settings, run `r3 config show` in your terminal.

## Key configuration settings

| Setting | What it controls |
| --- | --- |
| `backendUrl` | The backend endpoint your CLI and agent connect to. |
| `publicUrl` | 服务器对浏览器公开的地址；配置外部主机名后默认要求登录。 |
| `allowedHosts` | 额外允许访问的主机名；包含任何外部主机名时默认要求登录。 |
| `trustedProxies` | 受信任、可提供客户端地址的代理连接 IP；配置代理后默认要求登录。 |
| `requireLogin` | 显式要求（`true`）或关闭（`false`）浏览器和 API 身份验证，覆盖自动默认策略。 |
| `archiveTtlDays` | Minimum age before an archived artifact qualifies for cleanup (Default: 30 days). |
| `authTokenIdleDays` | 浏览器登录令牌在闲置多久后过期（默认：14 天）。 |
| `projectGrouping` | Automatic Git remote detection (`remote`) or explicit project assignment (`manual`). |

Server-level changes must be executed **on the host machine** and applied by running `r3 server restart`. (Updating `backendUrl` in the CLI takes effect immediately).

使用 `r3 config set requireLogin true` 可要求 localhost 访问也必须登录；使用 `r3 config set requireLogin false` 可关闭服务器端身份验证，即使配置了外部主机名或代理也会生效。使用 `r3 config unset requireLogin` 恢复自动默认策略：仅配置 localhost 且没有受信任代理时无需登录，配置外部主机名或受信任代理后要求登录。默认的仅本地访问模式会拒绝转发请求；显式设置 `requireLogin` 也会覆盖这一限制。如果设置了 `R3_REQUIRE_LOGIN`，它会优先于保存的配置。

关闭登录验证后，任何能通过允许的主机名连接到服务器的用户都能访问整个工作区。Host/origin 检查和预览隔离仍然生效。无论使用哪种模式，发布返回的 URL 都不包含会过期的登录码。远程 CLI 后端仍需通过 `r3 login` 授权，详见[本地与远程访问](/docs/access/)。

For remote server hosting and multi-device setups, see [Local & remote access](/docs/access/).
