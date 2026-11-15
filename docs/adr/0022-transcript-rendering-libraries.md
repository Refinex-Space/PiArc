# 0022. Transcript 渲染的库选型：@tanstack/react-virtual、marked 词法器、shiki JavaScript 引擎（补充）

- 状态：已接受（补充 ADR-0013 第 5 条，T09）
- 日期：2026-11-15
- 取代：无
- 相关：架构文档第 8.4、10.3、11 章；ADR-0013、ADR-0006；`docs/spikes/S01-transcript-composer.md`

## 背景

ADR-0013 第 5 条定下渲染进程的做法：长列表虚拟化，Markdown 解析与代码高亮放在 Web Worker 中，composer 基于 ProseMirror；具体库与版本在 M0 选定并精确锁定。T09 用合成的协议事件驱动渲染进程原型（`#/transcript-lab`），在同一组测量下比较候选，选定三类库。约束：

- CSP 不放宽（架构第 10.3 节）：`script-src 'self'`，没有 `'unsafe-eval'` 与 `'wasm-unsafe-eval'`；样式只能来自应用自身，不能有内联 `<style>` 与 style 属性字符串；
- 不用 `innerHTML` / `dangerouslySetInnerHTML`，解析器要输出语法树而不是 HTML 字符串，并支持 GFM 表格与任务列表；
- 流式中只重解析最后一个未完成的块，结束后与一次性解析结果一致。

测量环境：Apple M1 Max、32 GB、macOS 26.5.2（25F84），外接 60 Hz 显示器（窗口 1280×800 内容区，缩放 2），开发构建的打包产物，Electron 45.3.2。与第 11 章的基准机型（M1 Pro / 16 GB）不同。

## 决策

1. **虚拟列表：@tanstack/react-virtual 3.14.26**（virtual-core 3.19.11，MIT）。`anchorTo: 'end'`；行高按"行 id + 宽度"缓存（`RowHeights`），宽度变化时重新测量；可见区上下各约一屏预渲染（按像素计算的 `rangeExtractor`）。滚动跟随不用库的 `followOnAppend`，由自有状态机 `ScrollFollow` 决定，在列表尺寸容器的 ResizeObserver 回调中（布局后、绘制前）贴底。
2. **Markdown：marked 18.2.0 的词法器**（MIT），不用它的 HTML 渲染器。词法单元转换成自有的块与 span 中间结构（`ir.ts`），由 React 渲染。字符引用由 `character-entities` 2.0.2（MIT）的命名实体表解码；链接目标经 `safeHref` 只保留 `https:`、`http:`、`mailto:`。增量解析：稳定前缀 + 每次重新词法分析的尾部；尾部的起点是最后一个已开始且首行完整的块；流式中先闭合尾部未完成的围栏、行内代码、强调与链接目标；消息里出现过链接引用定义时，最后一次更新整体重解析。
3. **代码高亮：shiki 4.6.0 的细分包**（`@shikijs/core`、`@shikijs/engine-javascript`、`@shikijs/langs`、`@shikijs/themes`，MIT），在 Worker 中用 JavaScript 正则引擎（`oniguruma-to-es`，`forgiving: true`）与 `codeToTokensWithThemes`，输出每行的 token（文本、明暗两套颜色、字形位），React 以 `style` 对象设置颜色（CSSOM，不受 CSP 的 style 属性限制）。语法按需加载，每种语言一个 chunk；Markdown、MDX、Vue、PHP 等内嵌大量语言的语法不收录；超过 100,000 字符的代码不高亮。主题暂用 `github-light` / `github-dark`，T18 的设计令牌可以替换。
4. **composer：ProseMirror**（ADR-0013 已定），锁定 `prosemirror-model` 1.25.13、`prosemirror-state` 1.4.4、`prosemirror-view` 1.42.9、`prosemirror-keymap` 1.2.3、`prosemirror-commands` 1.7.2、`prosemirror-history` 1.5.1（MIT）。粘贴只接收纯文本。
5. Worker 以 ES module 从应用协议加载（Vite `worker.format: 'es'`），受同一份 CSP 约束。

## 测量数据

### 虚拟列表（同一组行组件、同一套滚动跟随，2026-11-15）

两个候选都实现过一次，跑同一组 S1 基准与 L4 滚动用例（对比时的代码在提交 `0387545`，`npm run bench:s1 -- --lists tanstack,virtuoso`）：

| 测量 | @tanstack/react-virtual | react-virtuoso 4.18.22 |
|---|---|---|
| 100 token/s 流式 60 s：每帧主线程工作 p50 / p99 / 最大 | 2.9 / 6.0 / 14.6 ms | 2.0 / 5.5 / 15.5 ms |
| 同上：超过 50 ms 的任务 | 0 | 0 |
| 同上：错过的帧（页面帧间隔超过 1.5 个显示帧）/ 合成器丢帧 | 0 / 0 | 8 / 13（另有 234 帧只部分呈现，1 个 108 ms 的长动画帧） |
| 1 万条 item、3,000 px/s 自动滚动 10 s：帧率 / 每帧工作 p99 | 60.0 fps / 2.2 ms | 60.0 fps / 2.9 ms |
| 1,000 条冷加载（5 次）中位 / 最大 | 50.6 / 58.4 ms | 99.6 / 107.4 ms |
| 渲染进程内存：空页面 / 1,000 条（GC 后） | 131 / 180 MiB | 132 / 179 MiB |
| L4 滚动跟随 5 个用例 | 5 通过 | 3 通过：流式增长时有一帧离底约 33 px（两个用例失败） |

"每帧主线程工作"是 CDP 追踪中两次 `BeginMainThreadFrame` 之间渲染主线程 `RunTask` 的总耗时。rAF 间隔和 `AnimationFrame`（LoAF 口径）在 60 Hz 屏上空闲时也约 16.7 ms，不能用来对照"p99 ≤ 16 ms"，只作参考。

### Markdown 解析（Node 24.14.1，同机）

| 输入 | marked 18.2.0（词法器） | mdast-util-from-markdown 2.1.0 + GFM | markdown-it 15.0.3 |
|---|---|---|---|
| 10 KB 混合内容 | 0.35 ms | 5.6 ms | 0.60 ms |
| 100 KB 混合内容 | 3.0 ms | 59.8 ms | 5.2 ms |
| 3,000 行代码块 | 0.31 ms | 14.6 ms | 0.64 ms |
| 约 570 字节的尾部段落（流式每次的量级） | 0.043 ms | 0.39 ms | 0.041 ms |

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| react-virtuoso 4.18.22（MIT） | 开箱即用；`followOutput`、`atBottomStateChange` 现成；滚动与内存与 tanstack 相当 | `followOutput` 只在条数变化时滚动，最后一条消息变高时不跟随；高度变化在它自己的测量周期（绘制之后）才报告，贴底晚一帧，流式时出现掉帧与约一行的抖动；在它的列表元素上用 ResizeObserver 设 `scrollTop` 会和它的初始定位冲突，曾出现一行都不渲染；尺寸缓存按索引，不能按"id + 宽度"复用；冷加载慢一倍 | 否决 |
| @virtuoso.dev/message-list（商业许可） | 专为聊天设计，支持流式变高时跟随 | 商业许可，需要 license key；两者都没扛住时才考虑（`electron-stack.md` 第 9 节） | 否决：tanstack 已满足 |
| micromark / mdast-util-from-markdown（MIT） | 完全符合 CommonMark；节点带位置；自带实体解码 | 慢 17–50 倍，流式中长代码块每次重解析 15 ms 量级；浏览器版的实体解码依赖 DOM，在 Worker 中要另行配置 | 否决 |
| markdown-it 15（MIT） | 快，接近 marked | 输出扁平的开闭 token 流，要自己组树；任务列表要插件 | 否决 |
| shiki 默认的 Oniguruma（WASM）引擎 | 与 VS Code 的语法匹配完全一致 | 需要 CSP 加 `'wasm-unsafe-eval'`，属于放松安全基线（变更型） | 否决：JavaScript 引擎不需要改 CSP |
| shiki 的 `codeToHtml` | 一步得到带颜色的 HTML | 输出 HTML 字符串，违反"不用 innerHTML"；内联 style 属性字符串被 CSP 拦截 | 否决 |

## 后果

- 正面：
  - 流式 60 秒没有超过 50 ms 的任务，每帧主线程工作 p99 约 6 ms；万条滚动 60 fps；冷加载约 50 ms；1,000 条时渲染进程 180 MiB，均在第 11 章预算内；
  - 模型输出只经词法器与 React 元素进入 DOM，ESLint 禁止 HTML 字符串入口，CSP 不变；
  - 滚动跟随与列表库解耦，状态机可单测。
- 负面与代价：
  - marked 不是逐字符合 CommonMark 的实现，个别边角输入的结构可能与规范不同；字符引用要自行解码；
  - JavaScript 正则引擎对少数语法模式不支持，`forgiving` 会跳过它们，个别语言的高亮可能不完整；
  - 增量解析依赖"块的范围只取决于下一块首行之前的内容"这一性质，用切分方式的性质测试（任意切分下最终结果等于一次性解析）守住；
  - 滚动跟随依赖列表在内容增长的同一帧报告尺寸变化，换列表库时要重新验证。
- 需要配套做的事：T19 把原型接到真实事件流；T18 的设计令牌替换高亮主题与颜色；T44 把 `npm run bench:s1` 的指标接入 CI；W0 在 Windows 上复测。

## 重新评估的触发条件

- marked 的输出与用户期望的渲染出现系统性差异（例如常见输入结构错误），或 marked 停止维护；
- 需要的语言在 JavaScript 正则引擎下不可用，或高亮性能成为瓶颈；
- 第 11 章的流式、滚动、冷加载或内存预算在基准机型或 Windows 上不达标；
- @tanstack/react-virtual 的大版本改变了 `anchorTo`、测量或滚动修正的行为。
