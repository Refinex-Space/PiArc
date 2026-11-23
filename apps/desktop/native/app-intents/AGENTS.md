# PiArc 的快捷指令扩展

这是独立进程的 ExtensionKit App Intents 扩展。macOS 打包需要完整 Xcode；机器默认使用 Command Line Tools 时，在打包命令的环境中选择 Xcode。构建与实机操作见 [App Intents](../../../../docs/engineering/app-intents.md)。

- 放在主应用的 `Contents/Extensions/`。保持扩展自己的 App Sandbox entitlement；先让 Forge 重签 Electron，再嵌入签好的扩展和 Node，最后只签封外层应用。
- 打开动作要明确指定包含该扩展的 PiArc 应用，尤其是同一台机器装有多个构建时。
- 快捷指令的草稿 URL 有 4096 个 UTF-16 代码单元的上限。Foundation 会保留字面加号，WHATWG 的查询解码会把它当作空格，原生路由测试覆盖该差异。
- `Metadata.appintents` 由 Xcode 针对目标架构生成。快捷指令 App 搜索并实际运行成功才算实机验收。
