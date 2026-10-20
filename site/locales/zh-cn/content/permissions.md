<!-- visual: permissions -->

## Choose what a page can access

HTML artifacts execute scripts in the browser. Previews run in an opaque sandbox with no access to your r3 auth credentials or external network APIs.

关闭工作区登录验证不会关闭预览隔离、Host/origin 检查或网络与设备的权限控制。

If your browser cannot verify native origin isolation, r3 prompts for **compatibility consent**. Once granted, r3 remembers your choice so you are not prompted repeatedly.

## Grant only what the task requires

If a prototype requires third-party API access, it can request **external networking**. Grant this only when you trust the page, as it permits outbound requests. Whenever possible, have your agent bundle fonts, images, and dependencies directly into the artifact.

Camera and microphone access require explicit permission prompts from both r3 and your browser. A persistent indicator lets you stop media capture at any time.

If a preview pauses after a background tab is suspended, click **Retry** to reload the sandbox without publishing a new version.
