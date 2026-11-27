# 0091. 浏览器 SDK 内化 ego-browser（补充）

- 状态：已接受（补充）
- 日期：2026-11-26
- 相关：ADR-0089；[设计增补第 4.5 节](../architecture/addenda/browser.md)；`docs/plan/references.md`

## 背景

ego-lite（https://github.com/citrolabs/ego-lite，MIT）开源了智能体端的浏览器驱动 SDK `package/ego-browser`（TaskSpace/Page API、元素解析、ref 注册表、等待、输入、对话框、弹窗、下载）与使用说明 `skill-body/SKILL.md`；浏览器本体与原生快照闭源。SDK 通过 `globalThis.ego` 原生绑定与浏览器通信，依赖 Node 的 fs、child_process、AsyncLocalStorage 与 acorn。

## 决策

1. **移植上游提交 `56589ea8b98fd3b17a5d2316bfd8ff7b803d3293`** 到 `apps/desktop/src/browser-host/sdk/`，保留文件布局与名称以便对照上游；每个文件头注明来源路径、上游提交与 MIT 许可，`LICENSE` 随目录保存；`third-party/sources.json` 登记。上游更新按文件对照合入，改动清单记在该目录的 `AGENTS.md`。
2. **保留**：browser-runtime、cdp-eval、element-resolver、page-model、page-ref-registry、page-ledger、snapshot-result、ego-errors、native-gate、output-sink、format、public-api-schema、run、driver/*。**删除**：learning/*、v1 兼容层、update-notice、skill-migration、http、clipboard、env、CLI 入口。
3. **替换 Node 依赖**：`globalThis.ego` 换成 PiArc 的 `PiarcBindings`（ADR-0089 的绑定集合，另加 `ledgerLoad/Save`、`stageUpload`、`saveFile`、`attachImage`、`requestAccess`、`servers/startServer`）；`AsyncLocalStorage` 换成显式运行上下文；`util.inspect` 换成本地格式化；`help()` 的数据由构建期从 `public-api-schema.ts` 生成；截图返回图片编号并附进工具结果。
4. **快照由 PiArc 实现**（主进程 `snapshot.ts`），满足 ego 的快照规格；自定义 CDP 域 `egoAutomated` 不存在，相关分支删除。
5. **严格类型与 lint，不加豁免**：`any` 换成具体类型，CDP 类型取 `devtools-protocol`（BSD-3-Clause，开发依赖，只用类型）。ego 的 `*.test.mjs` 移植为 Vitest，另以真实 CDP 轨迹做 golden 回放。
6. **使用说明改编** ego 的 `skill-body/SKILL.md` 为 `agent-host/src/harness/prompts/browser.ts`（文件头注明出处与改动）：删去 Node、安装、shell 形式与平台段落，加入 PiArc 的闸门、截图、控制权与数据边界。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 原样 vendor，目录排除 lint | 同步上游最省事 | 绕开仓库的类型与 lint 门禁 | 否决 |
| 按 PiArc 风格重写 | 代码风格统一 | 丢掉与上游的对应关系，修复难以同步 | 否决 |
| 直接依赖 npm 包 | 无移植 | 上游包是 Node CLI，依赖 `globalThis.ego` 原生绑定与 Node API | 否决 |

## 后果

- 正面：得到 ego 已验证的页面操作语义与错误分类；与上游保持可对照。
- 负面与代价：约 1.5 万行代码的类型化移植；上游大改时合入成本高。
- 需要配套做的事：`third-party/sources.json`、`docs/plan/references.md`、目录 `AGENTS.md`。

## 重新评估的触发条件

- 上游发布不兼容的 v3 API；
- 上游开源原生快照或浏览器本体。
