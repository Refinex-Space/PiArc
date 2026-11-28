---
paths:
  - "apps/**"
  - "agent-host/**"
  - "packages/**"
  - "scripts/**"
---

# TypeScript 规则（精要）

完整规范见 `docs/engineering/coding-standards.md` 第 3 章。

- 不放宽 `tsconfig.base.json` 的严格选项（3.1）。
- 禁止 `any`：用 `unknown` 加类型守卫收窄；边界数据（AHP、IPC、NAPI、文件、网络、`JSON.parse`）校验后才使用，不用 `as` 断言未校验的数据；不用非空断言 `!`（3.2）。
- 只导入类型时用 `import type`；相对导入写 `.js` 扩展名（3.2、3.3）。
- 跨工作区只按包名导入（`@piarc/protocol`），不导入其他工作区的内部文件（3.3）。
- 渲染进程不碰 Node 与原生模块，只调 preload 白名单；主进程不放业务逻辑（3.3，ADR-0013）。
- `@earendil-works/*` 只用包入口导出，禁止深度导入（3.4）。
- `packages/protocol/src/generated/` 是生成物，不手工编辑（3.3）。
- npm 依赖用 `npm install --save-exact`，不出现 `^`、`~`（1.4）。
- 脚本（`scripts/**/*.mjs`）：JSDoc 写类型；`spawn` 加参数数组，不经 shell；npm 命令用 `resolveBin` + `node` 运行；路径用 `path.join`；先查 `coding-standards.md` 第 4 节的复用表（3.6）。
- JSDoc 类型断言对 ESLint 不可见：`JSON.parse` 的结果经 `readJsonFile` 得到 `unknown` 再用 `isRecord` 收窄（3.6）。
- 禁用 ESLint 规则写 `// eslint-disable-next-line <rule> -- <reason>`（3.5）。
- 测试与源文件同目录，`*.test.ts` / `*.test.mjs`，Vitest（`testing.md`）。
- 改完运行 `npx vitest run <路径>`、`npm run lint`、`npm run typecheck`。
