## Feedback didn't reach the agent

Click **Use in agent** and paste the copied command into your agent’s chat session. Copying the command does not dispatch comments by itself—your agent must run it to fetch the batch.

If delivery fails, run `r3 worker status`. If you see a sandbox warning, run `r3 worker restart` from a standard host terminal outside your agent's sandboxed environment.

## An expected revision isn't showing

Click **Go to the latest version** in the navbar. Local edits on disk do not appear in r3 until your agent explicitly publishes a new version.

If images, fonts, or stylesheets appear broken, verify whether the agent bundled those assets locally. Remote web resources are blocked by default unless granted through the [permission prompt](/docs/permissions/).

## An element target is missing

Click **Locate** on the thread to return to the original version where the comment was anchored. If an element moved or changed identity, ask your agent to provide a linked fix target in its reply. For diffs with limited context, ask the agent to capture more surrounding lines.

## Sign-in or mutations stopped working

仅配置 localhost 时，通常无需登录。如果出现令牌提示，请在服务器所在机器上运行 `r3 config show`，检查是否设置了 `requireLogin=true`，在 `publicUrl`、`allowedHosts` 中配置了外部主机名，或配置了 `trustedProxies`。同时检查 `R3_REQUIRE_LOGIN` 是否覆盖了保存的设置。默认的仅本地访问模式会以 HTTP 403 拒绝转发请求；设置反向代理时，请将 `publicUrl` 配置为预期的公开地址。升级 r3 或修改服务器配置后，需要重启服务器才能生效。登录策略与覆盖设置请参阅[配置](/docs/configuration/)。

浏览器需要登录时，请使用该服务器的浏览器登录令牌。若要在服务器所在机器上立即登录，可运行 `r3 open` 获取有效期为 60 秒的一次性链接；如果使用前已过期，重新运行即可。智能体提供的普通 Artifact 链接不会过期，也不会自动完成登录。如果 CLI 访问被拒绝，请检查选中的后端 URL 并重新运行 `r3 login`；这个命令授权的是 CLI 访问，不是浏览器登录。

在尝试编辑或评论之前，请确保已归档的 Artifact 已被**恢复**。

If you see protocol warnings between the CLI and server, update both binaries to matching versions. If you encounter unexpected bugs, [open an issue on GitHub](https://github.com/hyperlogue/r3/issues) with reproduction steps (excluding private code and credentials).
