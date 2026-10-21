## 安装 Skill

在终端中运行以下命令，然后选择你的编程智能体：

```sh
npx skills add hyperlogue/r3 --skill publish-artifacts-to-r3 --global
```

该 Skill 会自动配置你的智能体。评审完全在你的本地设备上运行——除非你选择[连接自己的服务器](/docs/access/)，否则无需任何账号或外部服务器。

## 让你的智能体发布

> 创建一个带有可见性设置的项目创建表单。将其发布到 r3 并分享链接，以便我进行审查。

准备好后再打开智能体返回的链接即可；Artifact 链接不包含会过期的登录码。本地服务器默认无需登录；如果你开启了登录，运行 `r3 open` 让当前浏览器登录。详见[本地与远程访问](/docs/access/)。

<!-- visual: workspace -->

## 进行你的首次评审

1. 直接测试界面。
2. 开启**评论模式**，点击任何需要调整的元素并写下你的批注。
3. 点击**发送给智能体**。如果你的智能体并未在后台运行，点击**在智能体中使用**并将命令粘贴到对话中。
4. 检查智能体的修订版本，对比改动，并在满意后点击**解决**。

[体验示例](/example/index.html)或了解[如何提供精准反馈](/docs/feedback/)。

## 其他安装方法

或者安装 CLI：

```sh
npm install -g @hyperlogue/r3
```

```sh
bun add -g @hyperlogue/r3
```

在 NixOS 上：

```sh
nix run github:hyperlogue/r3#r3 -- guide
```

然后让你的智能体阅读 `r3 guide`。运行 `r3 --help` 查看命令。
