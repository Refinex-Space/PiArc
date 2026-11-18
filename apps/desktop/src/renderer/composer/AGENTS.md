# Composer

ProseMirror 处理编辑、候选面板和键盘意图。正式会话由 `shell/Conversation.tsx` 接线，`shell/session-input.ts` 将草稿发给 Core。输入协议与持久化见 [ADR-0030](../../../../../docs/adr/0030-transcript-and-composer.md)。

## 不变量

- `schema.ts` 的提及节点保存 `{id, label, path}`，胶囊显示 `@label`，`serializeDoc` 生成发给模型的 `@path` 与 UTF-16 区间。路径相对于搜索根并统一用 `/`。输入框每个实例使用独立的搜索 ID，旧结果和已取消的查询都不能覆盖新候选。
- `composerInfo()` 提供斜杠命令、附件种类及大小和搜索结果上限。新增命令在 Core 登记，面板按其动作与来源展示，内置说明走中英消息目录。
- 拖放、粘贴与选择文件都先经 `checkFiles`。待发送的附件是 `Blob` 和展示信息。发送时逐个将字节经 `window.piarc.storeAttachment` 交给 Core，向会话传 `InputAttachment` 引用。限制由 `piarc_core::composer::attachments` 定义，渲染进程按 Core 的返回值预检。
- pi-ai 1.5.2 的 `UserMessage.content` 支持文本或图像块。图片作为图像块送给模型，PDF 由 Agent Host 通过 `fs/pdf` 请求 Core 提取前 20 页以内的文本。原文件留在会话附件目录，后续页由 Read 按页读取。归档保留附件，删除会话才移除。
- 合成期间的 `isComposing`、键码 229 和 `view.composing` 都经过输入法守卫。按键在 `handleDOMEvents.keydown` 层处理，让 Enter/Esc 留给候选框，合成文本中的 `/`、`@` 保持普通输入。
- 运行中 Enter 为 steer，Mod+Enter 为 follow-up，Esc 停止。排队项以 `session/queueChanged` 为准。编辑已排队的文本会清除原提及区间并保留附件。
