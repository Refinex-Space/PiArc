# R2 · M1 macOS 阶段评审

**阶段门暂缓。** 两种严格 mock 协议在开发版和打包版均完成真实文件编辑、手动审批和 Bash 测试。真实模型尚未完成工作流。读取状态和项目信任存在已核实的接口语义问题，见 [ADR-0034](../adr/0034-bind-read-and-trust-confirmation.md)。M2 的前提是关闭阶段门所列问题并复核。W1 重点是 Windows shell、进程树、凭据和桌面实机交互。

## 双协议与真实模型

基线 `d57c72e`，macOS arm64。执行 `PIARC_EVIDENCE_TASK=R2 npm run test:e2e -w @piarc/desktop -- r2-workflow`，4/4。每种形态都通过设置页添加自定义端点，Messages 用 mock 根地址，OpenAI Chat Completions 用同一 mock 的 /v1，均选 fixture 模型。每个用例用独立的严格 mock 和空白应用数据目录。

在含空格和中文的工作区创建 sum.cjs、sum.test.cjs。初始 3 + 2 返回 1，Node 单元测试报 ERR_ASSERTION。会话通过 Read 取得两份源文件，在 Manual 卡片允许一次 Edit，再允许一次 Bash 执行 `node --test sum.test.cjs`。逐请求检查实际线格式、模型收到的源代码和测试输出，独立重跑通过，测试文件逐字节保持原内容。各次真实网络交换 4 次，端点均为本地测试服务器。夹具和 W1 可复用入口在 `apps/desktop/e2e/r2-workflow.e2e.ts`，截图在 `tmp/evidence/R2/l4/`。

另在打包应用配置关闭云端的本机 Ollama，使用已安装的 deepseek-r1:7b（OpenAI Chat Completions）执行相同初始项目和用户指令。服务端记录 1 次推理请求，HTTP 200，费用 0。模型直接输出文字建议，未发起 Edit 或 Bash，等待真实审批卡超时。该运行未达到退出标准。证据见 `tmp/evidence/R2/local-run.log`、`local/l4/`。真实服务商未验证；本次没有使用付费远程凭据。

## 前序验收状态

按 task 精确筛选 acceptance.json，T13–T22 共 126 项，全部 passing，blocked、failing、not_started 各 0。各任务已登记的通过数如下。

| 任务 | passing |
|---|---:|
| T13 | 14 |
| T14 | 13 |
| T15 | 11 |
| T16 | 11 |
| T17 | 13 |
| T18 | 14 |
| T19 | 14 |
| T20 | 14 |
| T21 | 11 |
| T22 | 11 |
