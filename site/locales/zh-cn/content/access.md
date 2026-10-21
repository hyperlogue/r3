<!-- visual: access -->

## 在你的设备上

本地服务器会按需自动启动，并且默认要求登录。运行 `r3 open`，打开打印出的一次性链接，即可让当前浏览器登录。链接有效期为 60 秒；持续使用浏览器时，登录会话会保持有效。

`r3 create` 和 `r3 publish` 返回的 Artifact 链接是稳定地址，你可以稍后阅读智能体的回复，并在已登录的浏览器中打开链接。智能体应分享普通的 Artifact 地址，而不是 `r3 open` 生成的链接。

如果服务器仅供本机访问，可运行 `r3 config set requireLogin false` 关闭登录。此时 r3 会拒绝代理转发的请求；配置了任何外部访问时，服务器都无法在关闭登录的状态下启动。

## 连接到远程服务器

在智能体的机器上运行：

```sh
r3 config set backendUrl https://reviews.example
r3 login
```

请将示例地址替换为你的服务器 URL。在浏览器中打开授权 URL，按需登录，核对确认码并批准 CLI 访问。远程服务器要求登录，CLI 也需要单独完成这一步授权。CLI 仅在连接到已关闭登录的 localhost 后端时，才可不使用已保存的凭据。

**访问权限覆盖整个工作区。** 要求登录时，分享 Artifact 链接不会让接收者自动登录。关闭登录验证后，任何能通过允许的主机名连接到服务器的客户端都能访问工作区，包括同一台机器上的其他用户。r3 不提供单个 Artifact 的权限设置或团队角色。

## 自行托管

若要通过专用网络或域名访问 r3，请在回环服务器前配置 HTTPS 反向代理，转发所有路由（包括预览路由），并设置 `publicUrl`。必须保持登录开启，即使代理通过 localhost 连接也一样。在 `publicUrl` 或 `allowedHosts` 中配置外部主机名，或添加 `trustedProxies` 后，服务器无法在关闭登录的状态下启动。关闭登录的模式还会拒绝代理转发的请求。重启服务器以应用配置更改，然后使用 `r3 auth create-token --label browser` 生成浏览器登录令牌。

默认要求登录。只有监听地址、`publicUrl` 和 `allowedHosts` 都限于回环地址，且未配置受信任代理时，才能显式设置 `requireLogin=false`。两种模式都会保留 Host/origin 检查和预览隔离。覆盖设置请参阅[配置](/docs/configuration/)，登录问题请参阅[故障排查](/docs/troubleshooting/)。请直接在服务器所在机器上运行服务器和配置命令。
