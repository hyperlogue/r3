<!-- visual: access -->

## On your machine

打开智能体返回的 Artifact 链接，或运行 `r3 open` 并打开打印出的工作区地址。本地服务器会按需自动启动。仅配置 localhost 时，默认无需令牌、一次性登录码或浏览器登录会话。

`r3 create` 和 `r3 publish` 返回的 Artifact 链接是稳定地址，你可以稍后阅读智能体的回复并打开链接。如果你显式启用了本地登录，`r3 open` 可以生成供立即登录使用的一次性链接，其登录码有效期为 60 秒。智能体应分享普通的 Artifact 地址。

## Connect to a remote server

On the agent’s machine:

```sh
r3 config set backendUrl https://reviews.example
r3 login
```

请将示例地址替换为你的服务器 URL。在浏览器中打开授权 URL，按需登录，核对确认码并批准 CLI 访问。即使服务器设置了 `requireLogin=false`，远程 CLI 后端仍需要这一步授权；CLI 只会向 localhost 后端发送不带已保存凭据的请求。

**访问权限覆盖整个工作区。** 要求登录时，分享 Artifact 链接不会让接收者自动登录。关闭登录验证后，任何能通过允许的主机名连接到服务器的客户端都能访问工作区，包括同一台机器上的其他用户。r3 不提供单个 Artifact 的权限设置或团队角色。

## Host your own

若要通过专用网络或域名访问 r3，请在回环服务器前配置 HTTPS 反向代理，转发所有路由（包括预览路由），并设置 `publicUrl`。在 `publicUrl` 或 `allowedHosts` 中配置外部主机名，或添加 `trustedProxies` 后，默认会要求登录，即使代理通过 localhost 连接也一样。默认的仅本地访问模式会拒绝代理转发的请求。重启服务器以应用配置更改，然后使用 `r3 auth create-token --label browser` 生成浏览器登录令牌。

显式设置 `requireLogin=true` 或 `false` 会覆盖默认策略。两种模式都会保留 Host/origin 检查和预览隔离。覆盖设置请参阅[配置](/docs/configuration/)，登录问题请参阅[故障排查](/docs/troubleshooting/)。请直接在服务器所在机器上运行服务器和配置命令。
