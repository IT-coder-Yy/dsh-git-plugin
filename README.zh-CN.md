# deepseek-git-guide

[English](README.md) | [简体中文](README.zh-CN.md)

面向 DeepSeek Harness 的 Git 操作引导插件：把自然语言意图转换为经过校验的 Git 命令提议，并让用户在「直接执行」与「手动执行」之间选择。

> [!IMPORTANT]
> 本项目是社区项目，并非 DeepSeek 官方产品。DeepSeek Harness 当前仍处于开发者预览阶段，插件接口可能变化；发布版本会在下方记录兼容性基线。

## 目录

- [功能特性](#功能特性)
- [工作原理](#工作原理)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用示例](#使用示例)
- [安全模型](#安全模型)
- [开发与测试](#开发与测试)
- [许可证](#许可证)

## 功能特性

- **步骤化执行**：多步操作登记为独立步骤，逐步校验、逐步执行，任一步失败立即停止。
- **命令白名单**：固定 Git 子命令白名单，拒绝全局选项、外部子命令、shell 控制符、命令替换和可执行脚本入口。
- **风险分级**：操作分为只读、常规和高风险三级；高风险操作无论直接执行还是复制，都必须再次确认。
- **会话隔离**：提议按 Harness 会话隔离，使用随机 ID，成功或失败后均不可重放。
- **迁移校验**：手动执行采用「复制前基线 → 执行后目标状态」的校验；无法可靠归因时不会误报成功。
- **安全输出**：执行失败返回仓库诊断，输出中的 URL 凭据和常见令牌会被脱敏。

## 工作原理

```text
自然语言描述
    │
    ▼
git_propose ── 解析并校验每个步骤 → 登记为提议（随机 proposalId，绑定当前会话）
    │
    ▼
用户选择
    ├─ 直接执行 ── git_execute 按步骤运行，失败即停
    └─ 手动执行 ── 复制命令到终端，面板按「基线 → 目标状态」迁移校验
```

## 环境要求

- Node.js `^22.19.0 || >=24.0.0`
- 支持静态 Cordis 插件的 DeepSeek Harness 开发者预览版本
- Git

当前兼容性冒烟基线为 `@deepseek-ai/dsh@0.1.0-rc.6`（包括同版本的 Shell、Tools、WebServer 和 Client Runtime）。本项目不直接安装这些运行时服务，它们由 Harness profile 提供。

## 安装

发布到 npm 后，将插件安装到目标 profile：

```bash
dsh plugin --profile <profile-name> add deepseek-git-guide
```

仅从 GitHub 安装当前源码版本：

```bash
dsh plugin --profile <profile-name> add github:IT-coder-Yy/deepseek-git-guide
```

`package.json` 中的 `dsh.bundle.patch` 会自动合并 [git-guide.cordis.yml](git-guide.cordis.yml)，无需再手工复制挂载配置。安装后按你的正常方式重新启动该 profile。

本地开发可直接安装仓库路径；需要单独调试补丁时也可以：

```bash
dsh web --patch ./git-guide.cordis.yml
```

插件注册三个模型工具：

| 工具 | 说明 |
| --- | --- |
| `git_repo_state` | 只读获取仓库状态。 |
| `git_propose` | 校验并登记一个或多个 Git 步骤。 |
| `git_execute` | 仅按同会话中的 `proposalId` 执行已登记提议。 |

Web profile 还会在 `conversation.input.dock` 显示交互面板；headless/TUI profile 只使用模型工具。

## 使用示例

```text
你：把文档更新提交到当前分支，提交信息为 docs: update guide

提议：
1. git add docs/guide.md
2. git commit -m "docs: update guide"
```

直接执行时，Host 按步骤运行并展示每步结果。选择手动执行时，多步命令会以 `&&` 连接，确保失败即停；面板只会在目标状态相对于复制时基线发生预期迁移后标记为已验证。

## 安全模型

插件把模型输出视为不可信输入，并在登记和执行两个阶段重复校验：

1. 每个步骤只能是一条 `git <子命令> ...` 命令，且子命令必须位于固定白名单中。
2. 参数会被解析后重新进行 shell 安全引用；禁止 `;`、`&`、管道、重定向、`$()`、反引号和换行。
3. 禁止 `git -c` 等全局选项、未知 `git-*` 外部程序、`rebase --exec`、`ext::` transport，以及可能启动外部程序的选项。
4. 高风险操作需要显式确认；`proposalId` 严格绑定会话且只能执行一次。
5. RPC 只接受 JSON POST，拒绝明显的跨站请求，并限制请求体和身份字段大小。
6. 远程 URL 和诊断输出中的常见凭据格式会被脱敏。请始终使用 Git 凭据管理器，不要把令牌写进命令或 remote URL。

安全边界与已知限制：

- 命令在 Harness 提供的 Shell 与沙箱策略内执行；插件不会扩大该策略，但也不能替代主机级权限隔离。
- Git 本身可能读取仓库或用户配置并触发 hook、credential helper、pager、transport helper 等外部程序。只应在可信仓库和可信 Git 配置中使用本插件。
- 提议保存在 Host 内存中，进程重启后会丢失；这不是持久任务队列。
- 手动执行验证不是终端审计。对于缺少可靠目标状态的命令，插件只报告检测到变化，不会宣称命令已经执行。
- 子命令白名单有意保持保守；`config`、`submodule` 等具有额外执行面的命令不会被接受。

发现安全问题时请按 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 Issue 中披露利用细节。

## 开发与测试

```bash
npm run lint                              # 语法检查
npm test                                  # 单元 + 集成测试
npm run check                             # lint + test
npm pack --dry-run --ignore-scripts       # 检查发布内容
```

测试包含纯逻辑单元测试和真实临时 Git 仓库集成测试，覆盖命令边界、风险分级、会话隔离、防重放、分步失败、敏感信息脱敏及手动执行状态迁移。测试不会访问网络。

目录结构：

| 路径 | 说明 |
| --- | --- |
| `lib/index.js` | Host 插件、工具、RPC、安全校验与执行 |
| `lib/client.js` | Web Client 面板 |
| `test/unit.test.js` | 命令、风险、会话和 RPC 单元测试 |
| `test/integration.test.js` | 真实临时 Git 仓库集成测试 |
| `git-guide.cordis.yml` | 自动合并的 Cordis 补丁 |

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。发布前运行 `npm run check`；`prepublishOnly` 也会执行同一检查。

## 许可证

[MIT](LICENSE)
