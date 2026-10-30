<!-- visual: access -->

## 在你的设备上

本地服务器会按需自动启动。它仅监听本机，默认无需登录，因此 Artifact 链接可以直接打开。浏览器首次打开时，r3 会显示一次相关提示；运行 `r3 config set disableLoginNotice true` 可关闭该提示。

`r3 create` 和 `r3 publish` 返回的 Artifact 链接是稳定地址，你可以稍后阅读智能体的回复并打开链接。请分享这些普通 URL；本地 `r3 open` 生成的登录链接适合立即使用。

### 为本地服务器开启登录

不开启登录时，本机上能访问服务器端口的任何程序或用户账户都可以读取所有 Artifact，并向你的编程智能体发送评论。隧道或端口转发（例如 `ssh -L`）会把这种访问扩展到其他机器。此模式下，服务器会拒绝 HTTP 代理转发的请求，也不会创建登录令牌或 API 密钥。

要开启登录，请在本机运行：

```sh
r3 config set requireLogin true
r3 server restart
```

运行 `r3 open`，在 60 秒内打开打印出的登录链接。它会复用现有的浏览器会话，或授予仅保存在服务器内存中的临时访问权限，有效期为 24 小时，服务器重启时也会失效。过期的临时访问会自动清理，不会出现在可重复使用的令牌列表中。如需可重复使用的访问凭据，可运行 `r3 auth create-token --label browser` 创建登录令牌。`r3 config unset requireLogin` 恢复默认设置。

## 连接到远程服务器

在智能体的机器上运行：

```sh
r3 config set backendUrl https://reviews.example
r3 login
```

请将示例地址替换为你的服务器 URL。在浏览器中打开授权 URL，按需登录，核对确认码并批准 CLI 访问。远程服务器始终要求登录，CLI 也需要单独完成这一步授权。CLI 仅在连接到已关闭登录的 localhost 后端时，才可不使用已保存的凭据。

**访问权限覆盖整个工作区。** 要求登录时，分享 Artifact 链接不会让接收者自动登录。关闭登录验证后，任何能通过允许的主机名连接到服务器的客户端都能访问工作区，包括同一台机器上的其他用户。r3 不提供单个 Artifact 的权限设置或团队角色。

## 自行托管

若要通过专用网络或域名访问 r3，请在回环服务器前配置 HTTPS 反向代理，转发所有路由（包括预览路由），并设置 `publicUrl`。在 `publicUrl` 或 `allowedHosts` 中配置外部主机名，或添加 `trustedProxies` 后，登录会自动开启，即使代理通过 localhost 连接也一样；服务器无法以 `requireLogin=false` 启动。重启服务器以应用配置更改，然后使用 `r3 auth create-token --label browser` 生成浏览器登录令牌。

只有监听地址、`publicUrl` 和 `allowedHosts` 都限于回环地址，且未配置受信任代理时，才默认关闭登录；其他配置始终要求登录。两种模式都会保留 Host/origin 检查和预览隔离。覆盖设置请参阅[配置](/docs/configuration/)，登录问题请参阅[故障排查](/docs/troubleshooting/)。请直接在服务器所在机器上运行服务器和配置命令。
