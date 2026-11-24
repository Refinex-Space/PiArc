# 会话文件

Files 由会话 ID 和项目相对路径寻址，根由 Core 确定。主 checkout、会话 cwd 和 worktree 可能不同。输入器引用经过 `file-path.ts` 转成当前会话能解析的路径，绝对路径只用于系统操作与展示。打开普通文件或选区只改草稿。

树、标签、查找与编辑保留在所属会话。外部写入先刷新干净的阅读视图，保存脏草稿时必须携带最初的 revision。移动工具、弹出以及收回窗口仍是同一组件实例，焦点和尺寸通过 `useSurfaceDocument` 取实际呈现文档。

HTML 文档、媒体和 PDF 由主进程的短期本地预览地址交付。HTML 静态打开，受信任工作区可由用户主动运行本地脚本。`piarc-document:` 不得成为可信 IPC 来源。安全边界见 ADR-0076。

Markdown 图片的 `file:` 链接或含 `../` 的相对链接交给 `loadMarkdownImage`，由 Core 检查文档和已授权图片目录。它返回可撤销的图片 URL。组件移出视口或文档关闭时释放 URL。图片保存方式和链接格式在设置面板的 Markdown 页中更改。

文件 Markdown 使用独立的 Worker 和 CodeMirror 状态。预览和分栏始终读取当前草稿；视图切换保留光标、撤销和保存冲突保护。KaTeX 使用原生 MathML，Mermaid 在离线专用文档中绘制，父页面只接收图像。图表引擎不从应用可信来源提供。编辑与本地图片设置见 [ADR-0077](../../../../../docs/adr/0077-markdown-file-authoring.md)。

正文右键、选区浮条、表格把手与斜杠菜单应在所属窗口、当前文档上操作。编辑事务沿用 CodeMirror 的原文和撤销记录，阅读选区按实际 DOM 映射回源文件行。图片和 Mermaid 使用同一大图查看器，源码右键也须经当前文档的资源授权。粘贴只由主进程在核实真实菜单手势和目标编辑区后发给窗口。改动这条路径时运行桌面端的 `markdown-context`、`markdown-table`、`markdown-media` 和 `markdown-workspace` 交互用例。
