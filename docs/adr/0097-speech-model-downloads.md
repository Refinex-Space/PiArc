# 0097. 增强语音模型的下载

- 状态：已接受（补充）
- 日期：2026-11-26
- 取代：无
- 相关：架构文档第 10.1 节（THR-19）；ADR-0082、ADR-0094；[语音输入设计增补](../architecture/addenda/voice-dictation.md) 3.7、4.7 节

## 背景

增强模式用 Qwen3-ASR 0.6B INT8 对每个语音片段做离线精修，权重约 982 MB，不内置。sherpa 发布的归档（878 MB 的 tar.bz2）要在应用里解包，带来路径穿越、链接、解压炸弹与双倍磁盘空间的问题。ModelScope 上同一转换的仓库 `zengshuishui/Qwen3-ASR-onnx` 按文件提供，锁定 revision 后其 `conv_frontend.onnx`、`encoder.int8.onnx`、`decoder.int8.onnx` 与 tokenizer 文件的 SHA-256 与归档成员逐个相同；下载会从 `modelscope.cn` 重定向到 `cdn-lfs-*.modelscope.cn`。

Core 现有的 HTTP 客户端 `piarc_web::Fetcher` 把响应整体缓冲进内存、不走代理、不跟随跨站重定向（I112），不适合下载大文件；用户的代理设置（ADR-0082）只以环境变量交给 Agent Host。

## 决策

1. 下载器在 `piarc_web::download`：只用 HTTPS；每一跳（至多 5 跳）主机都必须在本次请求的白名单里；直连时做 SSRF 检查，只连接检查过的地址；有代理时用 Core 的生效代理（ADR-0082）以 `CONNECT` 建隧道；不放宽 TLS；字节数超过清单声明的大小立即中止；流式写入暂存文件并边写边算 SHA-256；已有暂存时带 `Range` 续传，服务器不支持时从头；可取消。
2. 增强模型的清单（文件、URL 与 revision、大小、SHA-256、许可）编进 Core；渲染进程只传模型 id。按文件下载到 `DataDirs.cache()/speech/.staging/<模型>/`，全部校验通过后 rename 为 `<模型>/` 并写校验记录；运行时不解包任何归档。
3. 下载只在用户经设置页确认后进行，单飞，进度与状态在 `core/speech` 广播；关闭设置页不取消；取消清理暂存。
4. 每个进程第一次加载模型前核对全部文件的大小与 SHA-256，不一致标为损坏、不加载，设置页提供重新下载。
5. 删除增强模型：先切回基础模式并释放引用，主进程原生确认后删除目录；使用中不能删除。
6. 新增威胁 THR-19"语音模型被替换或篡改"，对策为第 1、2、4 条；同一用户的进程改写数据目录，沿用 THR-10 的已接受风险。外连登记在 `docs/security/egress.md`。

## 备选方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 下载 GitHub 归档并在应用内解包 | 与 sherpa 发布一致 | 要 bzip2 与 tar、解包防护、双倍空间 | 不采用 |
| 复用 `Fetcher` | 已有 | 整体缓冲、无代理、不跟随重定向 | 不采用 |
| 在 `piarc-speech` 里写下载器 | 离使用方近 | TLS 与连接的不变量分散到两个 crate | 不采用 |

## 后果

- 正面：没有解包风险；代理与 TLS 规则集中在 `piarc-web`；校验在加载前。
- 负面与代价：ModelScope 的 CDN 在中国大陆以外可能较慢；首次加载要哈希约 1 GB。
- 需要配套做的事：`piarc-web` 的下载测试（本地 HTTPS 与 CONNECT 夹具）、`egress.md`、threats.yaml。

## 重新评估的触发条件

- ModelScope 的文件或重定向主机变化。
- 官方提供带签名的模型发布。
