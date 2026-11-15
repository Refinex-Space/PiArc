# ghostty-web `CanvasRenderer`（fork）

终端渲染原型的 Canvas 渲染器，fork 自 ghostty-web（ADR-0017 第 4 条，T10）。

| 项 | 内容 |
|---|---|
| 来源仓库 | https://github.com/coder/ghostty-web |
| 路径 | `lib/renderer.ts` |
| 提交 | `640db4617c69a73ccebce437cebc598c7f73cdb7`（`v0.4.0-21-g640db46`，2026-10-28）；该文件最后一次修改在 `174a5547a4a6f178455f10e7928adb4fd300896f` |
| 许可证 | MIT，`Copyright (c) 2025 Coder`，全文见同目录 `LICENSE`（原样复制） |
| 登记 | `third-party/sources.json` 的 `ghostty-web-canvas-renderer` 条目（T50 生成 `THIRD_PARTY_NOTICES` 时读取） |

`renderer.ts` 文件头保留了上游的标题与版权声明，并注明来源与修改。

## 保留的部分

- 字体度量：以 `M` 的宽度向上取整作为格宽，ascent + descent 加 2 px 作为格高。
- 画布尺寸：CSS 尺寸按格数计算，像素尺寸乘以 `devicePixelRatio`，再 `scale`。
- 两遍绘制：每行先画全部背景，再画全部文字与装饰；脏行连同上下相邻行一起重画（字形溢出）。
- 文字样式：粗体、斜体字体，淡色用 `globalAlpha` 0.5，反色交换前景与背景，不可见不画字。
- 下划线与删除线的位置；块状、下划线、竖线三种光标的画法；块状光标内用背景色重画字符。
- 光标移动时重画新旧两行，渲染完成后清除脏标记。

## 改动清单

1. 数据源：`IRenderable` 改为由 Core 帧协议驱动（实现在 `../../remote-renderable.ts`）。单元格直接携带字素文本与已解析的 RGB（`RenderCell`），去掉上游按码点取字、`getGraphemeString` 查字素与打包的 RGB 字段。
2. 样式位改用 libghostty-vt 的样式标志（`CELL_FLAGS`），替换上游的 `CellFlags`；新增上划线；各种下划线（双线、波浪、点、虚线）统一画单线，并使用单元格的下划线颜色。
3. 颜色来自终端（帧中的背景、前景、光标色），去掉上游的主题与 16 色调色板；没有自身背景的单元格用终端背景，而不是上游判定"黑色即默认"。
4. 删除选区管理、OSC 8 与正则链接的悬停下划线、scrollback 与滚动条（选区、链接、滚动由 T34 实现）。
5. 删除光标闪烁的定时器（原型只画稳定光标）；新增空心块状光标。
6. 新增输入法预编辑文本的绘制：在光标处用终端背景铺底、前景色写字并加下划线；预编辑变化时重画光标所在行。
7. 跳过空单元格与空格的 `fillText`（无装饰时）。
8. 宽字符（CJK、emoji）的字形在两格内水平居中（字体给出的字宽通常小于两格，上游左对齐后右侧留缝）；字宽按字体与文本缓存。
9. 按仓库规范改写：严格 TypeScript（无非空断言、`noUncheckedIndexedAccess`）、ESLint 规则、模板字符串中的数字显式转成字符串。
