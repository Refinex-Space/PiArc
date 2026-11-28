# 品牌资产

应用图标与标记的单一来源。打包、托盘、界面中的 logo 都从这里取用，不在别处另存副本。

## 文件

| 文件 | 用途 |
|---|---|
| `icon.svg` | 应用图标矢量源：白色圆角方底 + 黑色 Pi 字形，1024 × 1024，方底铺满画布（Windows 与通用场合的造型） |
| `icon.png` | 512 × 512 位图，与 `icon.svg` 同造型，用于需要 PNG 的场合 |
| `icon.iconset/` | macOS 各尺寸位图（16 至 1024），按 macOS 图标网格留边，由 `mark.svg` 导出；`icon.icns` 由它生成，从源码运行时的 Dock 图标用其中的 1024 px 图 |
| `icon.icns` | macOS 应用图标（Electron Forge `packagerConfig.icon`） |
| `icon.ico` | Windows 应用图标，含 14 个尺寸（安装包与窗口图标），与 `icon.svg` 同造型 |
| `mark.svg` | 单独的 Pi 字形，跟随明暗模式反色；用于界面内 logo，以及菜单栏 / 托盘图标的源文件 |
| `mark.LICENSE` | Pi 字形来源的 MIT 许可证（必须随资产保留） |
| `trayTemplate.png`、`trayTemplate@2x.png`、`tray-light.ico`、`tray-dark.ico` | 菜单栏与托盘图标，由 `mark.svg` 导出（T35） |
| `providers/*.svg`、`providers/sources.json` | 模型服务商的品牌标记（ADR-0107），来源与哈希见下文“服务商标记” |

重新生成 macOS 图标（`icon.icns` 一步只能在 macOS 上执行，`--check` 比对已提交的文件）：

```bash
node scripts/dev/export-mac-icon.mjs [--check]
```

macOS 的 Dock 与访达把每个图标画在 1024 画布上，圆角方底宽 824、四周各留 100 的透明边放阴影；铺满画布的方底在 Dock 里会比旁边的图标大一圈。所以 `icon.iconset/` 不从 `icon.svg` 缩放而来：脚本把 `icon.svg` 的造型以画布中心缩放到 824 / 1024（圆角 224 × 824 / 1024，字形 1.28 × 824 / 1024），再在下方加一层柔和阴影（向下 10、模糊 σ 10、不透明度 0.3，均按 1024 画布）。Windows 的 `.ico` 没有这层留边，保持铺满。

## 来源

- 全部文件取自已废弃的 PiDeck 项目（`packages/shared/assets/`，2026-10-27）。只拷贝了资产，没有使用它的代码。
- `icon.svg` 的 `<title>` 由 PiDeck 改为 PiArc，图形未改动；位图与 `.ico` 原样拷贝。
- `icon.icns` 最早是 2026-11-14 用 `iconutil` 从 PiDeck 的 `icon.iconset/` 生成的（铺满画布）；2026-11-26 起 `icon.iconset/` 与 `icon.icns` 改由 `scripts/dev/export-mac-icon.mjs` 按 macOS 网格导出。
- Pi 字形来自 thesvg.org 的 Pi 图标（<https://thesvg.org/icon/pi>，源文件 <https://github.com/GLINCKER/thesvg/blob/main/public/icons/pi/default.svg>），按 MIT 许可证使用，许可证全文见 `mark.LICENSE`。

## 使用注意

- 这个字形就是 Pi 项目自己的 logo 造型（Pi 在终端中用珊瑚、蓝、黄三色绘制同一个 "P + i" 像素图形），PiArc 用的是黑白版本。thesvg 的 MIT 许可证只覆盖这份 SVG 文件，不授予 Pi 名称或 logo 的商标权利。公开发布前要确认是否需要 Pi 项目的许可，或改用派生标记（需求规格 D3）。
- 构建产物的第三方许可证清单（`THIRD_PARTY_NOTICES`）要包含 `mark.LICENSE`。
- 菜单栏 / 托盘图标由 `node scripts/dev/export-tray-icons.mjs` 从 `mark.svg` 导出（T35）：`trayTemplate.png`、`trayTemplate@2x.png`（16、32 px，黑色加透明的 macOS template 图）与 `tray-light.ico`（黑）、`tray-dark.ico`（白，深色任务栏）（Windows，16–48 px 的 PNG 条目）。改了 `mark.svg` 后重新导出并提交，`--check` 比对已提交的文件。打包时作为 `Resources/` 下的资源。

## 服务商标记

`providers/` 中的 33 个 SVG 是模型服务商的品牌标记，只用于在"添加服务"、连接列表与模型菜单中标识对应的服务商（ADR-0107）。

- **来源**：LobeHub Icons（<https://github.com/lobehub/lobe-icons>，图标站 <https://icons.lobehub.com/>）的 npm 包 `@lobehub/icons-static-svg@1.106.0`，取包内 `icons/` 下的 mono 版，文件未做任何修改。tarball 地址、sha512 与每个文件的 SHA-256 记在 `providers/sources.json`。
- **许可证**：MIT，Copyright (c) 2023 LobeHub，全文见 `third-party/licenses/lobe-icons.LICENSE`，在 `third-party/sources.json` 中登记为 `lobe-icons-provider-marks`。发布构建的 `THIRD_PARTY_NOTICES` 必须包含它。
- **商标**：各标记是对应公司的商标，归其所有者。MIT 许可只覆盖 SVG 文件，不授予商标权利。PiArc 与这些公司没有关联，也未获其认可，使用标记只为标识用户连接的服务。
- **Radius**：Pi 自己的服务，沿用本目录的 `mark.svg`（来源见上文）。
- **生成**：`node scripts/dev/gen-provider-marks.mjs` 先核对每个文件的哈希，再生成 `apps/desktop/src/renderer/shell/provider-marks.generated.ts`。加一个标记时，从同一版本的包里取文件，把它的 SHA-256 写进 `sources.json`，在 `shell/provider-marks.ts` 里加识别规则，然后运行脚本。升级包版本时，`version`、`integrity` 与全部哈希一起更新。`--check` 比对已提交的输出，Vitest 也会比对。
