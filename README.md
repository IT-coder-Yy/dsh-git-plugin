# deepseek-git-guide 🧭

**DeepSeek Harness Cordis 插件（静态 npm 包形态）**：当你想对代码做 git 操作、却不知道具体命令时，用自然语言描述意图，插件会给出**最简洁、最安全**的命令建议与中文解释，最后由你决定**直接执行**还是**复制命令手动执行**。

> 发布到 npm 后，任何 DeepSeek Harness profile 都可以通过
> `dsh plugin --profile <名字> add deepseek-git-guide` 安装，并在组合里挂载一行即可使用。

---

## ✨ 功能特性

| 能力 | 说明 |
| --- | --- |
| 🗣️ 意图 → 命令 | 用户自然语言描述操作（如"撤销最近一次提交但保留改动"），模型选择最简最安全的纯 git 命令并给出中文解释 |
| 📋 多步骤提议 | 多条命令用 `steps` 数组分开传入，**逐步校验、逐步执行、失败即停**，每步单独显示 ✓/✗，不依赖 `&&` 黑盒拼接 |
| 🖱️ 双执行路径 | 面板 [直接执行] 由插件运行；[复制命令] 手动在终端执行 |
| ✅ 手动执行校验 | 复制后进入"待执行"，按命令类型校验**预期结果**（提交信息 / 当前分支 / 暂存文件 / 分支删除 / stash / 推送状态），区分 **已验证 / 部分执行 / 未执行** |
| 🔧 失败自动恢复 | 执行失败自动附带仓库诊断信息，并要求模型分析原因后提出**修正命令**（如加 `-f`、`git -c` 覆盖 ssh 参数、补步骤、先解冲突），新提议自动顶替旧提议 |
| 🛡️ 安全分级 | 只接受纯 git 命令（拒绝管道、重定向、`$(...)`、反引号等 shell 特性）；自动分级 **安全 / 常规 / 高风险**（`reset --hard`、force push、`rebase`、`clean -fd`、`branch -D` 等），高风险必须用户勾选确认才放行 |

## 🏗️ 工作原理

```
浏览器（Client · lib/client.js）                 Host 进程（lib/index.js）
┌──────────────────────────────┐   POST /git-guide  ┌──────────────────────────────┐
│ conversation.input.dock 面板   │ ←─ state/verify ───→│ ctx.webServer 路由            │
│ · 步骤列表 + 风险徽标           │ ←─ execute ────────→│ · 提议存储（按会话，内存）       │
│ · [直接执行] [复制命令]         │ ←─ dismiss/mark-   →│ · ctx.tools.register 三个工具  │
│ · 已验证/部分执行/诊断展示        │    copied          │ · 预期结果校验（deriveChecks）  │
└──────────────────────────────┘                     └──────────────────────────────┘
                                   模型工具：git_propose / git_execute / git_repo_state
```

- **Host**（`lib/index.js`）：`ctx.tools.register` 注册 3 个模型工具；`ctx.webServer` 注册 `POST /git-guide` 路由（`body.action` 分发）作为 Client→Host 通信；通过 `shell` 服务执行 git 命令。
- **Client**（`lib/client.js`）：产物为 web shell 模块加载器格式（`window.__ModuleLoader__.load({ id, factory })`，factory 内 `require("react")`）；`package.json` 的 `dsh.client` 声明使其进入 web bundle；面板注册在 `conversation.input.dock`；同源 `fetch('/git-guide')` 与 Host 通信。
- 依赖：Host 的 `shell` / `tools` / `webServer` 服务；Client 的 `slots` / `timer`（由 `@deepseek-ai/dsh-client-runtime` 提供）。
- 说明：headless / tui 等非 web profile 只获得三个模型工具（无交互面板），核心"意图 → 命令 → 执行"流程依然可用。

## 🚀 安装（供其他用户 / 其他 profile）

```bash
# 1. 把插件装进某个 profile（转发给 pnpm 安装）
dsh plugin --profile <名字> add deepseek-git-guide

# 2. 在组合里挂载它（临时补丁方式）
dsh web --patch ./git-guide.cordis.yml

#    或持久化：把 git-guide.cordis.yml 里的那一行并入 $DSH_HOME/cordis.patch.yml
```

`git-guide.cordis.yml` 内容（注意：新增顶层插件行必须用 `insert` 列表；直接写 `- id/name` 只会按 id 修补已有行、会被告警跳过）：

```yaml
- insert:
    - id: git-guide
      name: deepseek-git-guide
```

挂载后，输入框上方会出现"Git 操作建议"面板，模型工具（`git_propose` / `git_execute` / `git_repo_state`）对所有会话可用。

## 📦 发布

```bash
npm login                 # 你的 npm 账号
npm version patch         # 或 minor / major
npm publish               # 发布到 npm registry
```

未发布前也可以本地联调：把 `package.json` 里的 `repository.url` 换成你的地址后，
用 `dsh plugin --profile <名字> add <本地路径或 git 地址>` 安装。

## 💬 使用示例

```
你：撤销最近一次提交但保留改动
插件：git reset --soft HEAD~1   ← 面板出现命令 + 解释 + [直接执行] [复制命令]
你：直接执行 → 插件运行并展示结果，成功后面板自动关闭
```

```
你：把这几个文件提交到当前分支，提交信息 fix: update docs
插件：1. git add docs/api.md frontend/next.config.ts
      2. git commit -m "fix: update docs"
      ← 分步展示，逐步执行，失败即停
```

```
你（复制命令后在终端手动执行，只跑了第一步）：
插件：⚠ 检测到仓库状态变化，但预期结果未达成：最近提交信息应为「fix: update docs」
      ← 保留卡片，提示差距，可重新检测或放弃
```

## 🛡️ 安全模型

- **命令白名单**：每个步骤必须是 `git` 开头的命令；拒绝 shell 管道 `|`、重定向 `< >`、`$(...)`、反引号、命令替换；
- **结构校验**：目标目录必须是 git 仓库，命令长度受限；
- **风险分级**：只读命令（status/log/diff…）为安全；常规操作（add/commit/push…）为常规；破坏性 / 改写历史 / 强制推送 / 清空类命令为高风险；
- **双重确认**：高风险命令在 `git_propose` 与 `git_execute` 两处都要求 `confirm: true`（对应面板的"我已了解风险"勾选）；
- **执行门禁**：`git_execute` 只接受 `git_propose` 返回的 `proposalId`，不接受任意命令字符串；
- **RPC 边界**：`/git-guide` 路由与页面同源，仅本机可用（本地个人工具语义）。

## 📁 目录结构

```
deepseek-git-guide/
├── lib/
│   ├── index.js        # Host 插件：ctx.tools.register + /git-guide 路由 + 校验/执行/验证逻辑
│   └── client.js       # Client 插件：输入框上方交互面板（fetch RPC）
├── test/
│   ├── helpers.js              # 测试辅助：shell 适配器 + 临时 git 仓库
│   ├── unit.test.js            # 单测：命令校验 / 风险分级 / 预期结果推导
│   └── integration.test.js     # 集成测试：真实 git 仓库里的执行/校验/部分执行检测
├── git-guide.cordis.yml # 组合挂载示例（--patch 或并入 cordis.patch.yml）
├── package.json         # main/exports + dsh.client 声明（test/lint 脚本）
├── LICENSE              # MIT
└── README.md
```

## 🧪 测试

```bash
npm test          # node --test test/
npm run lint      # node --check lib/*.js
```

- 单测覆盖命令白名单、shell 特性拒绝、风险分级、预期结果推导；
- 集成测试在临时 git 仓库中跑真实流程：add+commit 逐步执行、commit-msg 校验、部分执行（只 add 不 commit）检测、切分支校验、失败即停、提议顶替。

## 🛠️ 常见问题

- **`dsh plugin ... add` 报 pnpm 不存在**：`dsh plugin` 命令是转发给 pnpm 的，需要先安装 pnpm（`npm i -g pnpm` 或启用 corepack）；也可以直接把本仓库目录符号链接进 profile 的 `node_modules` 等价安装。
- **面板没出现但工具可用**：`lib/index.js` 声明了 `inject: ['webServer']`，插件会等 webServer 服务就绪后再挂载路由（挂载时序问题，已内置处理）；非 web profile（headless/tui）本来就只有工具、没有面板。
- **`--patch` 新增行不生效**：补丁对不存在 id 的行只告警跳过，新增行必须用 `insert` 列表（见上）。

## 📄 License

[MIT](LICENSE)

---

*由 DeepSeek Harness 动态 Cordis 插件开发流程产出，随后移植为静态 npm 包形态。欢迎提 Issue / PR。*
