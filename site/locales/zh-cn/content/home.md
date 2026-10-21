# r3 — 审视智能体的工作，引导下一步行动。

探索智能体创建的 UI 原型、交互式解释器和设计文档。直接点击需要注意的地方，留下锚定批注，共同打磨最终成果。

默认在本地运行。[连接到你自己的服务器](/docs/access/)以将Artifact保留在远程后端，同时智能体仍在你的机器上运行。

## 功能特性

### 就工作成果进行评论。发送给你的智能体。

点击按钮、标题或输入框并留下批注。汇总你的反馈，然后一并批量发送给智能体，附带精准的元素及视口上下文。

[观看 18 秒演示](/assets/videos/precise-feedback.mp4) · [阅读文字稿](/assets/videos/precise-feedback.transcript.txt)

### 跟进回复。保留每一个版本。

智能体在同一个主题中回复，并将修改发布为新版本。更早的版本依然保留，方便你随时回看初始版本，并在准备好时打开最新版本。

[观看 10 秒演示](/assets/videos/agent-replies.mp4) · [阅读文字稿](/assets/videos/agent-replies.transcript.txt)

### 并排查看修复效果。

当智能体发布了修订版本，可从回复中打开“对比”。在修复旁边对照原始版本，检查问题是否已被解决。

[观看 10 秒演示](/assets/videos/inspect-fixes.mp4) · [阅读文字稿](/assets/videos/inspect-fixes.transcript.txt)

### 在评论中附加图像。

将屏幕截图、草图或设计原型直接附加到反馈中，向智能体展示预期的设计。

[观看 11 秒演示](/assets/videos/image-comments.mp4) · [阅读文字稿](/assets/videos/image-comments.transcript.txt)

### 针对精确的视频帧发表评论。

在片段的任意位置暂停，高亮标注区域并留下批注。捕获的时间戳与静止帧为智能体提供了明确无误的视觉上下文。

[观看 12 秒演示](/assets/videos/video-comments.mp4) · [阅读文字稿](/assets/videos/video-comments.transcript.txt)

首页将这五大功能与真实 r3 界面的无声可播放演示相结合。每个演示时长 10–18 秒并配有文字稿。录屏使用虚拟的本地数据和脚本化智能体回复。

## 开始评审

使用 `npx skills add hyperlogue/r3 --skill publish-artifacts-to-r3 --global` 安装发布 Skill，选择你的编程智能体，然后让智能体将其工作发布到 r3。无需全局安装 r3。

## 然后向你的智能体提问

首页在终端中演示了这些提示词。通用的发布指令保持不变，各示例渐隐交替。你可以选择一条提示词或暂停动画。

- **UI 原型：** 创建一个项目创建表单，以便我审查可见性设置。将 HTML Artifact发布到 r3。
- **解释器：** 用我可以亲自尝试的交互式滑块来解释搜索排名是如何工作的。将 HTML Artifact发布到 r3。
- **设计文档：** 编写一份关于项目可见性的设计文档，包括访问规则与权衡考量。将 HTML Artifact发布到 r3。

[安装 Skill](/docs/get-started/#install-the-skill) · [其他安装方法](/docs/get-started/#other-installation-methods) · [体验在线演示](/demo/) · [使用场景](/use-cases/) · [文档](/docs/)

首页的 [Example Fieldwork 工作区](/example/index.html)使用真实的 r3 React 页面，配合虚拟数据和脚本化智能体回复。
