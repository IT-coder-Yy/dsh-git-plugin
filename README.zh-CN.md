<div align="center">

# DSH Git Plugin

**面向 DeepSeek Harness Web 的可视化 Git 工作台：查看仓库、执行常用操作，并安全运行 AI 生成的 Git 工作流。**

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-Developer%20Preview-4f46e5)
![Web profile](https://img.shields.io/badge/profile-Web-0ea5e9)
[![npm version](https://img.shields.io/npm/v/dsh-easygit-plugin.svg)](https://www.npmjs.com/package/dsh-easygit-plugin)
[![GitHub repository](https://img.shields.io/badge/GitHub-Repository-181717?logo=github)](https://github.com/IT-coder-Yy/dsh-git-plugin)
[![MIT License](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)
[![LINUX DO](https://img.shields.io/badge/%E7%A4%BE%E5%8C%BA-LINUX%20DO-f59e0b)](https://linux.do)

[English](README.md) · 简体中文

</div>

## 怎么用

<p align="center">
  <strong>👀 查看 Git 状态 &nbsp;→&nbsp; 🖱️ 点击快捷操作或询问 Agent &nbsp;→&nbsp; ✅ 检查确认 &nbsp;→&nbsp; 🚀 执行</strong>
</p>

## 效果预览

![DSH Git Plugin 可视化工作台](./assets/preview.png)

## 功能

1. **可视化仓库状态**：查看当前分支、已暂存和未暂存文件，并查看每个文件的格式化审阅视图或原始 Diff。
2. **提交记录与详情**：通过提交图浏览当前分支历史；点击提交即可查看提交说明、作者、时间、父提交、变更文件、增删统计和完整 Diff。
3. **点击执行 Git 操作**：直接暂存或取消暂存单个/全部文件、创建提交，以及新建、搜索、切换或安全删除本地分支。
4. **远程同步与 Rebase**：查看上游、领先/落后提交数和工作区状态；执行 fetch、仅快进 pull、push、为新分支设置上游，以及安全地开始、继续或中止 Rebase。
5. **集中查看引用**：无需离开 DeepSeek Harness Web，即可查看本地分支、远程分支和标签。
6. **自然语言工作流**：将自然语言请求转换成清晰、分步骤的 Git 命令提议，然后直接执行或复制到终端手动执行。
7. **可追溯的失败处理**：保留失败命令、输出和失败后的仓库诊断；已识别的失败可给出安全修正提议，复杂失败可交由 Agent 分析。
8. **默认安全**：使用保守的命令白名单；高风险操作和历史重写必须确认；并提供防重复执行和诊断信息脱敏机制。

## 快速开始

### 0. 允许立即安装新发布的包

较新版本的 `pnpm` 可能延迟安装刚发布的包。若要立即安装最新版本，请在 `~/.dsh/profiles/web/pnpm-workspace.yaml` 中加入：

```yaml
minimumReleaseAgeExclude:
  - dsh-easygit-plugin
```

### 1. 安装插件

```sh
dsh plugin --profile web add dsh-easygit-plugin
```

### 2. 启动 DSH Web

```sh
dsh web
```

### 3. 打开 Git 工作台

点击输入框旁的 Git 按钮，即可查看变更和提交记录，也可以点击暂存文件、创建提交、管理分支或同步远程仓库。Rebase 和强制删除分支必须显式确认风险。

### 冲突解决

打开 **Git 工作台 → 冲突解决**，也可从“变更”或“同步”页进入：

1. 查看冲突文件列表和当前 Merge / Rebase / Cherry-pick 状态；也可以输入分支或提交引用发起操作。
2. 选择文件，对照基础版本、当前方、传入方和结果。每个冲突块支持采用当前方、采用传入方、按当前方在前保留双方，或定位到结果区手动编辑；支持跳到下一个冲突块。
3. 点击“保存结果”写入工作区，再点击“标记解决”暂存文件。仍有冲突标记时会拒绝标记；文件或 Git 操作被外部修改后，会要求重新加载，避免覆盖新内容。
4. 全部标记后继续当前操作；若进入下一轮冲突，列表会再次更新。也可显式确认后中止操作，或在 Rebase / Cherry-pick 中跳过当前提交（包括空提交）。

Rebase 的当前方指目标分支及已重放提交，传入方指正在重放的提交。删除 / 修改冲突可明确选择删除；二进制和非 UTF-8 文件可选择整份一方。文本编辑目前限每个版本 48 KiB；更大文件、符号链接和子模块请使用外部工具，再刷新列表。

未保存编辑会阻止页签切换，并在当前页面生命周期内保留草稿；刷新浏览器前会提示，但草稿不会跨浏览器刷新持久化。文件内容经已认证的会话接口读取，写入及 Git 操作均通过 Harness Shell 执行并沿用会话沙箱。

升级本地插件后需重启 Harness 后端并刷新浏览器，确保 Host 和 Client 同时加载新构建。

冲突解决功能的增量验证：91 项测试和 27 个可重复构建产物通过检查，包含四方读取、逐块选择、保存与标记、连续 Rebase 冲突、空提交跳过、linked worktree、旧快照拒绝及会话隔离。已在独立的临时 Harness 实例与真实 Git 仓库中完成 Merge、Rebase、Cherry-pick 浏览器流程，覆盖逐块选择、手动编辑、整份版本选择、保存、标记解决与继续操作；另覆盖合法分隔线、无提交仓库和特殊文件名回归。



遇到更复杂的工作流时，可以用自然语言告诉 Agent。例如：

```text
将文档更新提交到当前分支，提交信息为 "docs: update guide"
```

在 Git 工作台中检查生成的步骤，然后选择直接执行或手动执行。

## 从源码安装

```sh
git clone https://github.com/IT-coder-Yy/dsh-git-plugin.git
cd dsh-git-plugin
npm install
npm run build
dsh plugin --profile web add ${PWD}
```

## 从 GitHub 仓库安装

```sh
dsh plugin --profile web add github:IT-coder-Yy/dsh-git-plugin
```

## 更新插件

```sh
dsh plugin --profile web update dsh-easygit-plugin
```

## 卸载插件

```sh
dsh plugin --profile web remove dsh-easygit-plugin
```

## 工作原理

插件注册两个模型工具：

| 工具 | 说明 |
| --- | --- |
| `git_repo_state` | 只读获取当前仓库状态。 |
| `git_propose` | 校验并登记一个或多个 Git 操作步骤。 |

Web profile 会在输入框旁添加 Git 操作入口，并在原生右侧标签页中打开工作台。工作台通过多个标签页集中展示工作区变更与 Diff、分支与引用、提交记录与详情、贮藏、远程同步，以及 Agent 生成的操作提议。命令会在创建提议时和实际执行前分别进行校验。操作失败时，工作台会保留结构化错误上下文和仓库诊断；可识别的失败会生成新的修正提议，复杂失败则可交由 Agent 分析。

## 安全说明

- 每个步骤只能包含一条允许的 `git <子命令> ...` 命令。
- 禁止 shell 控制符、命令替换、重定向、可执行 hook 和不安全的 Git 选项。
- 高风险操作（包括历史重写）必须显式确认，每个提议只能执行一次。
- 插件遵循 DeepSeek Harness 提供的 Shell 和沙箱策略；请仅在可信仓库和可信 Git 配置中使用。

如需报告安全漏洞，请按照 [SECURITY.md](SECURITY.md) 中的方式私下联系。

## 兼容性

最后于 **2026-09-18** 使用 DeepSeek Harness `0.1.6-alpha.2` 和 dsh-easygit-plugin `0.3.0` 完成验证，对照上游源码提交 [`ddefc45`](https://github.com/deepseek-ai/deepseek-harness/commit/ddefc45fbc7f8e46dd73185e68295696d1297887)。`0.1.5-rc.2` 也已完成 Web 启动、标签页挂载和仓库读取验证。`0.3.x` 使用新的右侧标签页与会话接口，不再适配旧版 `0.1.0-rc.8`。

本次适配包括：原生右侧标签页（宽度、分栏和关闭由 DSH 管理）、会话作用域的 Agent 分析请求、尚未创建 Agent 及冷会话的仓库访问，以及复用 DSH Connection 的浏览器认证和来源检查。冷会话保留已记录的沙箱模式；没有有效会话时不会回退到任意工作目录。

验证范围：`npm run check`（72 项测试、24 个可重复构建产物）、npm 发布包 dry-run，以及 `0.1.6-alpha.2` 浏览器中的仓库读取、Diff、暂存、提交和原生标签页操作。Git 集成测试使用临时仓库，覆盖分支、贮藏、fetch/pull/push、成功与冲突 Rebase、修正建议和提议安全校验。真实模型生成回复未纳入本次验证。

要安装与上述源码版本一致的官方包，无需自行编译：

```sh
npm install -g @deepseek-ai/dsh@0.1.6-alpha.2
```

升级前建议备份 DSH 安装与 Web profile，并检查其他第三方插件是否兼容新版本；旧插件可能引用上游已删除的设置接口，导致整个 profile 无法启动。

## 开发

需要 Node.js `^22.19.0 || >=24.0.0`、Git，以及支持静态 Cordis 插件的 DeepSeek Harness 开发者预览版本。

```sh
npm install
npm run check
npm pack --dry-run --ignore-scripts
```

## 许可证

[MIT](LICENSE)
