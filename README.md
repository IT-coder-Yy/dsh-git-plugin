<div align="center">

# DSH Git Plugin

**A visual Git workbench for inspecting repositories, running common actions, and safely executing AI-generated Git workflows in DeepSeek Harness Web.**

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-Developer%20Preview-4f46e5)
![Web profile](https://img.shields.io/badge/profile-Web-0ea5e9)
[![npm version](https://img.shields.io/npm/v/dsh-easygit-plugin.svg)](https://www.npmjs.com/package/dsh-easygit-plugin)
[![GitHub repository](https://img.shields.io/badge/GitHub-Repository-181717?logo=github)](https://github.com/IT-coder-Yy/dsh-git-plugin)
[![MIT License](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)
[![LINUX DO](https://img.shields.io/badge/community-LINUX%20DO-f59e0b)](https://linux.do)

English · [简体中文](README.zh-CN.md)

</div>

## How to use

<p align="center">
  <strong>👀 Inspect Git state &nbsp;→&nbsp; 🖱️ Run a quick action or ask the Agent &nbsp;→&nbsp; ✅ Review &nbsp;→&nbsp; 🚀 Execute</strong>
</p>

## Preview

![DSH Git Plugin visual workbench](./assets/preview.png)

## Features

1. **Visual repository state**: See the current branch, staged and unstaged files, and each file's formatted review view or raw diff.
2. **Commit history and details**: Browse the current branch as a commit graph, then click a commit to inspect its message, author, timestamps, parents, changed files, statistics, and full diff.
3. **One-click Git actions**: Stage or unstage one file or all files, create commits, and create, search, switch, or safely delete local branches directly from the workbench.
4. **Remote sync and Rebase**: Inspect upstream, ahead/behind counts, and working-tree state; fetch, fast-forward pull, push, set an upstream for a new branch, or safely start, continue, and abort a Rebase.
5. **References at a glance**: Inspect local branches, remote branches, and tags without leaving DeepSeek Harness Web.
6. **Natural-language workflows**: Turn a request into a clear, step-by-step Git command proposal, then execute it directly or copy it for manual execution.
7. **Actionable failure handling**: Keep the failed command, output, and post-failure repository diagnostics together; offer a safe recovery proposal for recognized failures or let the Agent analyze a complex failure.
8. **Safety by default**: Validate commands against a conservative allowlist, require confirmation for high-risk operations and history rewrites, prevent proposal replay, and redact common credentials from diagnostics.

## Quick start

### 0. Allow immediate installation of the new package

Newer versions of `pnpm` may delay recently published packages. To install the latest release immediately, add `dsh-easygit-plugin` to `~/.dsh/profiles/web/pnpm-workspace.yaml`:

```yaml
minimumReleaseAgeExclude:
  - dsh-easygit-plugin
```

### 1. Install the plugin

```sh
dsh plugin --profile web add dsh-easygit-plugin
```

### 2. Start DSH Web

```sh
dsh web
```

### 3. Open the Git workbench

Use the Git button beside the composer to inspect changes, review commit history, stage files, commit changes, manage branches, or synchronize with a remote. Rebase and forceful branch deletion require an explicit risk confirmation.

### Undo and amend commits

Use **Changes → 提交撤销与修正** for the latest commit, or open a commit in **Commit history** to access its actions.

- **Edit the latest message**: prefill the complete message and edit multiple lines (up to 48 KiB), leaving staged and working-tree content unchanged.
- **Amend the latest commit**: include all staged changes while keeping its message. Unstaged changes are excluded.
- **Undo the latest commit, keep changes**: use `reset --soft` to move to the first parent while preserving the index and working-tree files. The initial commit cannot be undone this way.
- **Revert a commit**: create a reverse commit for a commit in the current branch's history. Requires a clean index and working tree. For merge commits, explicitly select the mainline parent whose relative changes should be reversed. Conflicts open the conflict workflow, with continue, abort, and skip controls. If there is nothing to revert, Git diagnostics are displayed.

Each operation requires confirmation. The first three rewrite local history and can affect synchronization of published commits; they never force-push automatically. Changes to the branch, HEAD, or index invalidate the loaded state and require a refresh and fresh confirmation. Unfinished Git operations and unresolved conflicts block amendments. Related views refresh after execution.

### Branch merging

Open **Git workbench → 合并分支 (Merge branches)**, select a local or fetched remote branch, and preview incoming commits and file changes before merging into the current local branch.

- **Normal**: fast-forward when possible; otherwise create a merge commit.
- **Fast-forward only**: reject diverged histories without creating a merge commit.
- **Squash**: stage the combined changes, then finish with a single-parent commit or abort.

Conflicts open the existing three-way editor. Save and mark each file resolved, then continue or explicitly confirm an abort. Pending merges can also be finished or aborted from the merge tab. Completed merges cannot be undone with abort. A clean worktree is required, and changed branch tips invalidate the preview.

The diff shows source changes since the common ancestor, not the final merge result or a conflict prediction. Preview limits are 200 commits, 500 files, and 180,000 diff characters, with truncation notices. Unrelated histories are rejected. Remote branches use locally fetched references; fetch updates from Sync first if needed.

Verified in an isolated Harness browser instance with real Git repositories: all three merge modes, normal/squash conflict resolution and abort, remote sources, colliding reference names, and stale-preview rejection. The full check passes 130 tests and 30 reproducible build artifacts.

### Conflict resolution

Open **Git workbench → 冲突解决 (Conflict resolution)**, also linked from Changes and Sync:

1. Inspect conflicted files and the active Merge / Rebase / Cherry-pick operation, or start an operation using a branch or commit reference.
2. Compare three panes: current side, incoming side, and editable result, with commit references and short SHAs identifying the two sides. Each pane shows its own line numbers; result numbers track editing and scrolling and highlight unresolved conflicts. Each block shows its result line range and count (including markers). Accept either side, keep both with the current side first, edit manually, or jump to the next block.
3. Save the result to the working tree, then mark it resolved to stage it. Remaining conflict markers block resolution; external file or operation changes invalidate the snapshot instead of silently overwriting new content.
4. Continue after all files are resolved. Further conflicts refresh the list. Explicit confirmation also enables abort, or skipping the current Rebase / Cherry-pick commit, including empty commits.

The incoming side is the actual conflict source for this operation, not necessarily the current branch’s remote upstream. During Rebase, the current side is the target branch plus replayed commits; the incoming side is the commit being replayed. Delete/modify conflicts offer explicit deletion. Binary and non-UTF-8 conflicts offer whole-side selection. Text editing supports up to 48 KiB per version; use external tools for larger files, symlinks, and submodules, then refresh.

Unsaved edits block tab switching and retain a draft for the current page lifetime. Browser reload warns before losing edits, but drafts do not persist across reloads. Authenticated session actions read the content; file writes and Git commands run through Harness Shell with the session sandbox policy.

After upgrading the local plugin, restart the Harness backend and refresh the browser so both Host and Client load the new build.

Conflict-resolution validation: all 92 tests and 27 reproducible build artifacts passed, covering base/side reads, three-pane display and commit sources, dynamic line numbers and conflict ranges, block choices, save/resolve, successive Rebase conflicts, empty-commit skipping, linked worktrees, stale snapshots, and session isolation. Full Merge, Rebase, and Cherry-pick browser workflows were verified using an isolated temporary Harness instance and real Git repositories, including block choices, manual edits, whole-side selection, saving, resolving, and continuing. Regression coverage also includes valid separator lines, unborn repositories, and special filenames.



For a more involved workflow, ask the Agent for a Git operation. For example:

```text
Commit the documentation update to the current branch with the message "docs: update guide"
```

Review the generated steps in the Git workbench, then choose direct execution or manual execution.

## Install from source

```sh
git clone https://github.com/IT-coder-Yy/dsh-git-plugin.git
cd dsh-git-plugin
npm install
npm run build
dsh plugin --profile web add ${PWD}
```

## Install from GitHub repository

```sh
dsh plugin --profile web add github:IT-coder-Yy/dsh-git-plugin
```

## Update the plugin

```sh
dsh plugin --profile web update dsh-easygit-plugin
```

## Uninstall the plugin

```sh
dsh plugin --profile web remove dsh-easygit-plugin
```

## How it works

The plugin registers two model tools:

| Tool | Description |
| --- | --- |
| `git_repo_state` | Reads the current repository state without modifying it. |
| `git_propose` | Validates and registers one or more Git steps. |

The Web profile adds a Git action beside the composer and opens the workbench in a native right-sidebar tab. Its tabs provide visual access to working-tree changes and diffs, branches and references, commit history and details, stashes, remote synchronization, and Agent-generated proposals. Commands are validated both when a proposal is created and immediately before execution. When an action fails, the workbench preserves structured error context and repository diagnostics; recognized failures can create a new recovery proposal, while complex failures can be handed back to the Agent for analysis.

**Full stash management**: In the Stashes tab, add an optional message, select all or individual files, and optionally include untracked files. Selected-file stashes preserve unrelated staged and working-tree changes. Select a stash to review each file with line numbers and highlighted changes, or switch to the raw diff, including saved untracked files. Apply retains the stash; pop deletes it only after successful restoration; drop requires confirmation. Creating a branch requires a clean worktree, starts from the stash's original base, switches branches, and drops the stash after successful restoration. Conflicted apply/pop operations retain the stash and link to Conflict resolution. The list shows the latest 100 stashes, details show up to 500 files, and truncated diffs are marked.

## Security

- Each step must contain exactly one allowed `git <subcommand> ...` command.
- Shell control operators, command substitution, redirection, executable hooks, and unsafe Git options are rejected.
- High-risk operations, including history rewrites, require explicit confirmation and proposals can only be executed once.
- The plugin follows the Shell and sandbox policies provided by DeepSeek Harness; use it only with trusted repositories and trusted Git configuration.

Please report vulnerabilities privately by following [SECURITY.md](SECURITY.md).

## Compatibility

Last verified on **2026-09-18** with DeepSeek Harness `0.1.6-alpha.2` and dsh-easygit-plugin `0.3.0`, against upstream commit [`ddefc45`](https://github.com/deepseek-ai/deepseek-harness/commit/ddefc45fbc7f8e46dd73185e68295696d1297887). Web startup, native tab registration, and repository inspection were also checked on `0.1.5-rc.2`. The `0.3.x` plugin uses the new sidebar and session APIs and no longer targets `0.1.0-rc.8`.

The adaptation uses native sidebar tabs (DSH owns sizing, splitting, and closing), session-scoped Agent analysis, repository access for sessions without a running Agent and persisted sessions, and DSH Connection browser authentication and origin checks. Persisted sandbox modes are preserved; unknown sessions never fall back to an arbitrary directory.

Validation covered `npm run check` (72 tests and 24 reproducible build artifacts), a dry-run npm package, and browser checks on `0.1.6-alpha.2` for repository inspection, diffs, staging, committing, and native tab operations. Git integration tests use temporary repositories and cover branches, stashes, fetch/pull/push, successful and conflicted Rebases, recovery, and proposal safety. Live model-generated replies were not exercised.

Install the official package matching that source version without building DSH yourself:

```sh
npm install -g @deepseek-ai/dsh@0.1.6-alpha.2
```

Back up the DSH installation and Web profile before upgrading, and check other third-party plugins for compatibility. Older plugins may reference removed settings APIs and prevent the entire profile from starting.

## Development

Requires Node.js `^22.19.0 || >=24.0.0`, Git, and a DeepSeek Harness developer preview release that supports static Cordis plugins.

```sh
npm install
npm run check
npm pack --dry-run --ignore-scripts
```

## License

[MIT](LICENSE)
