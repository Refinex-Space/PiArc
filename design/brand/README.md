# 品牌资产

应用图标与标记的单一来源。打包、托盘、界面中的 logo 都从这里取用，不在别处另存副本。

## 文件

| 文件 | 用途 |
|---|---|
| `icon.svg` | 应用图标矢量源：白色圆角方底 + 黑色 Pi 字形，1024 × 1024 |
| `icon.png` | 512 × 512 位图，用于界面内展示与需要 PNG 的场合 |
| `icon.iconset/` | macOS 各尺寸位图（16 至 1024），`icon.icns` 由它生成 |
| `icon.icns` | macOS 应用图标（Electron Forge `packagerConfig.icon`） |
| `icon.ico` | Windows 应用图标，含 14 个尺寸（安装包与窗口图标） |
| `mark.svg` | 单独的 Pi 字形，跟随明暗模式反色；用于界面内 logo，以及菜单栏 / 托盘图标的源文件 |
| `mark.LICENSE` | Pi 字形来源的 MIT 许可证（必须随资产保留） |

重新生成 `icon.icns`（只能在 macOS 上执行）：

```bash
iconutil -c icns design/brand/icon.iconset -o design/brand/icon.icns
```

## 来源

- 全部文件取自已废弃的 PiDeck 项目（`packages/shared/assets/`，2026-10-27）。只拷贝了资产，没有使用它的代码。
- `icon.svg` 的 `<title>` 由 PiDeck 改为 PiArc，图形未改动；位图与 `.ico` 原样拷贝。
- `icon.icns` 是 2026-11-14 用 `iconutil` 从 `icon.iconset/` 生成的。
- Pi 字形来自 thesvg.org 的 Pi 图标（<https://thesvg.org/icon/pi>，源文件 <https://github.com/GLINCKER/thesvg/blob/main/public/icons/pi/default.svg>），按 MIT 许可证使用，许可证全文见 `mark.LICENSE`。

## 使用注意

- 这个字形就是 Pi 项目自己的 logo 造型（Pi 在终端中用珊瑚、蓝、黄三色绘制同一个 "P + i" 像素图形），PiArc 用的是黑白版本。thesvg 的 MIT 许可证只覆盖这份 SVG 文件，不授予 Pi 名称或 logo 的商标权利。公开发布前要确认是否需要 Pi 项目的许可，或改用派生标记（需求规格 D3）。
- 构建产物的第三方许可证清单（`THIRD_PARTY_NOTICES`）要包含 `mark.LICENSE`。
- 菜单栏 / 托盘图标需要按平台规范另行导出（macOS 用黑色加透明的 template 图），源文件用 `mark.svg`；导出的文件也放在本目录。
