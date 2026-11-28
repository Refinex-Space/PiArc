# 0107. 模型服务商的品牌图标

- 状态：已接受（用户在 2026-11-28 确认全部图标可用，要求写好来源声明）
- 日期：2026-11-28
- 修订：ADR-0006 第 4 条"不使用 Anthropic 的 logo"：用来标识 Anthropic 服务商时可以使用它的标记，其余限制不变；`apps/desktop/AGENTS.md` 的"不引入第二套图标"不再覆盖服务商标记
- 相关：ADR-0029（设计令牌）、ADR-0078（图标只经 `shell/icons.tsx`）、ADR-0083（服务商连接）

## 背景

"添加服务"对话框、已连接的服务商列表和两处模型菜单都只显示服务商名称，几十个服务商挤在一起时很难一眼找到。用户希望像其他桌面智能体一样，在这些位置显示服务商的品牌图标。

调研了两个图标库：

- **LobeHub Icons**（`@lobehub/icons-static-svg`，MIT）：专门收录 AI 服务商，约 360 个品牌。Pi 1.5.2 的内置与登录服务商里，只有 Radius 没有图标。mono 版统一是 24 × 24、`fill="currentColor"`，没有写死的颜色。
- **thesvg.org**：收录约 7,959 个通用品牌。它的 AI 类图标与 LobeHub 的路径数据逐字相同，是转载；比 LobeHub 少 Ant Ling 与 Typesafe，mono 版有的不带 fill 属性，许可证按图标逐个标注。

渲染进程的 CSP 是 `img-src 'self' data:`，T45 的 L4 要求没有外连，所以不能从 CDN 加载图标。

## 决策

1. **来源**：只用 LobeHub 的 mono 版。需要的 SVG 原样拷到 `design/brand/providers/`。`sources.json` 记下 npm 包名、版本 1.106.0、tarball 的 sha512，以及每个文件的 SHA-256。许可证全文在 `third-party/licenses/lobe-icons.LICENSE`，`third-party/sources.json` 登记为 `lobe-icons-provider-marks`，发布时进入 `THIRD_PARTY_NOTICES`。Radius 是 Pi 自己的服务，用 `design/brand/mark.svg` 的 Pi 字形。
2. **不加 npm 依赖**：`scripts/dev/gen-provider-marks.mjs` 先核对哈希，再把 SVG 转成数据模块 `apps/desktop/src/renderer/shell/provider-marks.generated.ts`，内容是 view box 与 path。渲染进程不能从 HTML 字符串建 DOM，所以图标由 `shell/icons.tsx` 的 `ProviderMark` 用 React 画出来。生成器只接受这些文件实际用到的写法：path 的 `d`、填充与裁剪规则、填充不透明度。遇到其他写法直接报错，不会悄悄丢掉。Vitest 比对已提交的输出。
3. **颜色**：只用 `currentColor`，颜色跟随所在位置的文字令牌，亮色、暗色、高对比度模式都不用额外处理。不用彩色版，界面颜色仍然只来自设计令牌。
4. **识别规则**：都在 `shell/provider-marks.ts`，按以下顺序匹配：
   - Pi 的服务商 id，含 `-cn`、`-token-plan-…` 这类变体；
   - 自定义端点基础地址的主机，域名本身或它的子域名；
   - 自定义服务商 id 或名称中的一个词，例如 `deepseek-test`。

   都匹配不上时，本地端点画笔记本、其余画地球，都是 Lucide 字形。
5. **位置**：
   - "添加服务"的每张卡片；
   - 连接列表的服务商行与账号行；
   - 模型菜单：有多个服务商时画在服务商行上，只有一个服务商时画在模型行上；
   - 菜单搜索展开的模型结果沿用服务商行的图标。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 从 CDN 加载 | 不进仓库 | 违反 CSP 与"没有外连" | 否决 |
| 依赖 `@lobehub/icons`（React 组件） | 直接用组件 | 带 `@lobehub/ui` 与 antd 体系的 peer 依赖，体积大 | 否决 |
| 依赖 `@lobehub/icons-static-svg` 并在构建时读取 | 升级方便 | 安装约 1,000 个文件只用其中 33 个；仍要把 SVG 转成不经 HTML 字符串的形式 | 否决 |
| thesvg.org | 品牌更多 | AI 图标转载自 LobeHub 且缺两家，许可证按图标各异 | 否决 |
| 首字母徽标 | 没有商标问题 | 识别度低，不满足需求 | 不采用；匹配不上时回退到中性字形 |

## 保留的风险

- 品牌标记是各公司的商标。MIT 许可只覆盖 SVG 文件，不授予商标权。PiArc 只在服务商卡片、连接列表和模型菜单里用它们标识对应的服务，属于指名性使用，不作装饰或营销用途。若某家要求停用，从 `sources.json` 删掉对应条目再运行生成器即可，界面会回退到中性字形。
- 显示 Anthropic 的标记修订了 ADR-0006 第 4 条：PiArc 自己的产品名、图标、字体和配色仍不使用 Anthropic 的品牌元素，只有 Anthropic 服务商这一项显示它的标记。
- 词元匹配是启发式的：名字里带 `qwen` 的自定义服务商会显示 Qwen 的图标，即使它实际是转发服务。图标只用于识别，不影响路由或凭据。
