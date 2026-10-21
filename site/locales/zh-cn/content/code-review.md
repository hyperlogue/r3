一个小补丁可能在解决一个问题的同时留下另一个隐患。此变更使用 pending 标志来防止项目表单重复提交。评审的重点在于请求失败时会发生什么。

## 阅读补丁

检查新增的保护机制以及设置与清除 pending 的代码行。请求成功时，表单会再次变为可用状态。如果所 await 的请求抛出异常，执行将永远无法到达清除该标志的代码行。

<!-- visual: story-code-review-start -->

## 质疑失败路径

选中受影响的代码行，询问用户是否能够在不丢失输入内容的情况下重试。该主题会记录补丁新版本侧的精确行范围，以便智能体能直接检查失败路径。

<!-- visual: story-code-review-feedback -->

## 跟进修复

打开智能体关联的修订版本。catch 块会显示重试提示，并在任意结果后通过 finally 清除 pending。表单中的值依然得以保留。在决定该主题已解决之前，请核对这些变更。

<!-- visual: story-code-review-result -->

[体验此示例 →](/example/index.html?scene=code-review)

真实的 r3 界面。虚拟数据与脚本化回复。
