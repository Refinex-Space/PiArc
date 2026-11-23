# apps/desktop · src/main/platform

这里封装 Electron 主进程的系统集成。构建使用仓库根目录的 `npm run package:desktop -- --flavor development`。运行 `npx vitest run apps/desktop/src/main/platform apps/desktop/src/main/launch.test.ts` 验证跳转列表与启动参数。

- Windows 安装器的 `--packId`、快捷方式的 `--aumid` 和进程的 `app.setAppUserModelId` 必须同为 `cn.piarc.desktop`。安装器读 `app-identity.mjs`，主进程读 `app-identity.ts`，两者由标识测试核对。标识不一致会让开始菜单快捷方式与运行中进程使用不同的跳转列表。
- 最近工作区只来自 Core 的 `core/workspaces` 快照。Electron 的 `getJumpListSettings().removedItems` 约束下一次 `setJumpList`，把移除项写回会使整个自定义分类消失。两个固定任务通过启动参数打开界面。打包后的默认用户目录才更新跳转列表。安装器快捷方式打开这个目录，测试与其他隔离目录中的项目不会发布到它。API 见 [Electron 45.3.2 app 文档](https://github.com/electron/electron/blob/v45.3.2/docs/api/app.md#appsetjumplistcategories-windows)。
- macOS 包与原生组件须逐层做 ad-hoc 签名；随包的 Node 保留官方签名。详细规则见上级应用说明与 S06 打包报告。
