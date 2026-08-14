# deepseek-git-guide 🧭

**DeepSeek Harness 动态 Cordis 插件**：当你想对代码做 git 操作、却不知道具体命令时，用自然语言描述意图，插件会给出**最简洁、最安全**的命令建议与中文解释，最后由你决定**直接执行**还是**复制命令手动执行**。

> 本项目同时是「动态 Cordis 插件」的完整示例：Host 工具（`git_propose` / `git_execute` / `git_repo_state`）、Client 交互面板（`conversation.input.dock`）、Package 私有 RPC、安全校验与失败恢复闭环。

---

## ✨ 功能特性

| 能力 | 说明 |
| --- | --- |
| 🗣️ 意图 → 命令 | 用户自然语言描述操作（如"撤销最近一次提交但保留改动"），模型选择最简最安全的纯 git 命令并给出中文解释 |
| 📋 多步骤提议 | 多条命令用 `steps` 数组分开传入，**逐步校验、逐步执行、失败即停**，每步单独显示 ✓/✗，不依赖 `&&` 黑盒拼接 |
| 🖱️ 双执行路径 | 面板 [直接执行] 由插件运行；[复制命令] 手动在终端执行 |
| ✅ 手动执行校验 | 复制后进入"待执行"，按命令类型校验**预期结果**（提交信息 / 当前分支 / 暂存文件 / 分支删除 / stash / 推送状态），区分 **已验证 / 部分执行 / 未执行**，不会因"仓库状态变了"就误判成功 |
| 🔧 失败自动恢复 | 执行失败自动附带仓库诊断信息（状态 / 最近提交 / 分支跟踪 / 远程），并要求模型分析原因后提出**修正命令**（如加 `-f`、`git -c` 覆盖 ssh 参数、补步骤、先解冲突），新提议自动顶替旧提议 |
| 🛡️ 安全分级 | 只接受纯 git 命令（拒绝管道、重定向、`$(...)`、反引号等 shell 特性）；命令自动分级 **安全 / 常规 / 高风险**（`reset --hard`、force push、`rebase`、`clean -fd`、`branch -D` 等），高风险必须用户勾选确认才放行 |

## 🏗️ 工作原理

```
浏览器（Client）                                    Host 进程
┌─────────────────────────────┐      RPC       ┌──────────────────────────────┐
│ conversation.input.dock 面板 │ ←─git:panel-state→│ 提议存储（每会话，内存）        │
│ · 步骤列表 + 风险徽标         │ ←─git:verify─────→│ · git_propose  校验/登记建议   │
│ · [直接执行] [复制命令]       │ ←─git:execute────→│ · git_execute  按步骤执行     │
│ · 已验证/部分执行/诊断展示      │ ←─git:dismiss────→│ · git_repo_state 只读仓库现状 │
│                            │ ←─git:mark-copied─→│ · 预期结果校验（deriveChecks）│
└─────────────────────────────┘                   └──────────────────────────────┘
                                  模型工具：git_propose / git_execute / git_repo_state
```

- **Host 半区**（`src/host.js`）：注册 3 个模型工具 + 5 个 Client RPC 处理器；通过 `shell` 服务执行 git 命令。
- **Client 半区**（`src/client.js`）：注册 `conversation.input.dock` 面板，1.2s 轮询提议状态。
- 依赖：DeepSeek Harness（`cordis` agent preset）、Host `shell` 服务、Client `slots` / `timer` 服务。

## 🚀 如何安装

这是一个**动态 Cordis 插件**：不需要安装 npm 包，在 DeepSeek Harness 的会话里用 `cordis_define` 工具加载即可。

1. 打开一个使用 `cordis` agent preset 的会话；
2. 让模型执行 `cordis_define`，分别粘贴 `src/host.js` 与 `src/client.js` 的内容作为 `code.host` / `code.client`（文件头部的注释块可省略）；
3. `cordis_run` 激活，首次需在界面批准；
4. 激活后，输入框上方会出现"Git 操作建议"面板，三个工具（`git_propose` / `git_execute` / `git_repo_state`）自动可用。

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
- **执行门禁**：`git_execute` 只接受 `git_propose` 返回的 `proposalId`，不接受任意命令字符串。

## 📁 目录结构

```
deepseek-git-guide/
├── src/
│   ├── host.js        # Host 半区：工具 + RPC + 校验/执行/验证逻辑
│   └── client.js      # Client 半区：输入框上方交互面板
├── package.json       # 元数据（lint: node --check）
├── LICENSE            # MIT
├── README.md
└── .gitignore
```

## 🧪 开发

```bash
node --check src/host.js && node --check src/client.js   # 语法检查
```

## 📄 License

[MIT](LICENSE)

---

*由 DeepSeek Harness 动态 Cordis 插件开发流程产出，欢迎提 Issue / PR。*
