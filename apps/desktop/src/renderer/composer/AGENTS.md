# Composer

ProseMirror 处理编辑、候选面板和键盘意图。新会话与正式会话共用 `Composer`。首回合由 `shell/Home.tsx` 接线，经信任确认后创建会话、应用选定的模式及推理强度，再调用 `prepareOutgoing` 保存附件并发送。正式会话由 `shell/Conversation.tsx` 接线。输入协议与持久化见 [ADR-0030](../../../../../docs/adr/0030-transcript-and-composer.md)。

## 不变量

- 工作区与会话各自持有本窗口的未发送草稿。Shell 路由决定新会话所属的工作区。发送成功会清除草稿，Core 快照移除对应实体时释放编辑文档和附件。外部草稿单独编辑。
- `schema.ts` 的提及节点保存 `{id, label, path}`，胶囊显示 `@label`，`serializeDoc` 生成发给模型的 `@path` 与 UTF-16 区间。路径相对于会话当前目录并统一用 `/`。从 Files 加入的条目先由 `files/file-path.ts` 将工作树相对路径转换为会话相对路径。输入框每个实例使用独立的搜索 ID，旧结果和已取消的查询都不能覆盖新候选。
- `composerInfo()` 提供附件种类及大小和搜索结果上限。斜杠命令来自 `listCommands`（T37，`commands-list.ts`）：面板按来源分组（`SOURCE_ORDER`）、经 `src/shared/fuzzy.ts` 排序（名称、别名、描述），显示参数提示；新的内置命令在 Core 的 `piarc_config::skills::BUILT_IN_COMMANDS` 登记，并在 `builtins.ts` 给出动作与中英描述。选中非内置命令时 `fillCommand` 填入 `/名称 ` 等用户输入参数，不直接发送。
- 从系统拖放、粘贴与选择的文件都先经 `checkFiles`。工作区内部拖动使用带会话标识的 `application/x-piarc-project-files`，仅同会话输入器接受该提及。待发送的附件是 `Blob` 和展示信息。发送时逐个将字节经 `window.piarc.storeAttachment` 交给 Core，向会话传 `InputAttachment` 引用。限制由 `piarc_core::composer::attachments` 定义，渲染进程按 Core 的返回值预检。
- 当前会话的模型能力由 `sessionModels` 返回。拖放、粘贴和文件选择都在 `checkFiles` 按 `vision` 检查。草稿已有图片时，发送前再按当前模型检查并保留被拒的草稿。Agent Host 在送到模型前也检查图片，以覆盖会话切换与已排队的输入。
- pi-ai 1.5.2 的 `UserMessage.content` 支持文本或图像块。图片作为图像块送给模型，PDF 由 Agent Host 通过 `fs/pdf` 请求 Core 提取前 20 页以内的文本。原文件留在会话附件目录，后续页由 Read 按页读取。归档保留附件，删除会话才移除。
- 合成期间的 `isComposing`、键码 229 和 `view.composing` 都经过输入法守卫。按键在 `handleDOMEvents.keydown` 层处理，让 Enter/Esc 留给候选框，合成文本中的 `/`、`@` 保持普通输入。
- 运行中草稿为空时发送位显示停止，有草稿时显示发送；两者互换后 `SWAP_GUARD_MS`（500 ms）内落在新按钮上的点击被忽略，防止连点把刚写的消息当成停止。运行中的占位文字说明 Enter 插话、Mod+Enter 排队。会话提示（`shell/NoticeBar.tsx`）在输入卡片上方。
- 运行中 Enter 为 steer，Mod+Enter 为 follow-up，Esc 停止。排队项以 `session/queueChanged` 为准。编辑已排队的文本会清除原提及区间并保留附件。
