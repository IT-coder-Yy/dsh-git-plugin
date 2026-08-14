# deepseek-git-guide

[English](README.md) | [简体中文](README.zh-CN.md)

A Git workflow guidance plugin for DeepSeek Harness. It turns natural-language intent into validated Git command proposals and lets users choose between direct execution and manual execution.

> [!IMPORTANT]
> This is a community project and is not an official DeepSeek product. DeepSeek Harness is currently in developer preview, and its plugin APIs may change. The compatibility baseline for each release is documented below.

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage example](#usage-example)
- [Security model](#security-model)
- [Development and testing](#development-and-testing)
- [License](#license)

## Features

- **Step-by-step execution**: Multi-step operations are registered as independent steps, validated and executed one at a time, and stopped immediately if any step fails.
- **Command allowlist**: A fixed allowlist of Git subcommands rejects global options, external subcommands, shell control operators, command substitution, and executable script entry points.
- **Risk classification**: Operations are classified as read-only, routine, or high-risk. High-risk operations always require an additional confirmation before either direct execution or copying.
- **Session isolation**: Proposals are isolated by Harness session, use random IDs, and cannot be replayed after either success or failure.
- **Transition validation**: Manual execution is checked against a “baseline at copy time → expected target state” transition. The plugin does not report success when the result cannot be reliably attributed to the proposed command.
- **Safe output**: Execution failures include repository diagnostics, with URL credentials and common token formats redacted.

## How it works

```text
Natural-language request
    │
    ▼
git_propose ── Parse and validate each step → Register a proposal (random proposalId, bound to the current session)
    │
    ▼
User chooses
    ├─ Execute directly ── git_execute runs each step and stops on the first failure
    └─ Execute manually ── Copy commands to the terminal; the panel validates the baseline → target-state transition
```

## Requirements

- Node.js `^22.19.0 || >=24.0.0`
- A DeepSeek Harness developer preview release that supports static Cordis plugins
- Git

The current smoke-tested compatibility baseline is `@deepseek-ai/dsh@0.1.0-rc.6`, including the matching Shell, Tools, WebServer, and Client Runtime packages. This project does not install those runtime services directly; they are provided by the Harness profile.

## Installation

After the package is published to npm, install it into the target profile:

```bash
dsh plugin --profile <profile-name> add deepseek-git-guide
```

To install the current source version directly from GitHub:

```bash
dsh plugin --profile <profile-name> add github:IT-coder-Yy/deepseek-git-guide
```

The `dsh.bundle.patch` field in `package.json` automatically merges [git-guide.cordis.yml](git-guide.cordis.yml), so no manual mount configuration is required. Restart the profile using your usual workflow after installation.

For local development, you can install the repository path directly. To debug the patch independently, run:

```bash
dsh web --patch ./git-guide.cordis.yml
```

The plugin registers three model tools:

| Tool | Description |
| --- | --- |
| `git_repo_state` | Reads the repository state without modifying it. |
| `git_propose` | Validates and registers one or more Git steps. |
| `git_execute` | Executes a registered proposal only when given a `proposalId` from the same session. |

The Web profile also displays an interactive panel in `conversation.input.dock`. Headless and TUI profiles use only the model tools.

## Usage example

```text
You: Commit the documentation update to the current branch with the message "docs: update guide"

Proposal:
1. git add docs/guide.md
2. git commit -m "docs: update guide"
```

With direct execution, the Host runs each step and displays its result. With manual execution, multi-step commands are joined with `&&` so execution stops on failure. The panel marks the operation as verified only after the expected target-state transition is observed relative to the baseline captured when the commands were copied.

## Security model

The plugin treats model output as untrusted input and validates it twice: once during registration and again before execution.

1. Each step must contain exactly one `git <subcommand> ...` command, and the subcommand must be included in a fixed allowlist.
2. Arguments are parsed and then safely quoted again for the shell. Semicolons, ampersands, pipes, redirections, `$()`, backticks, and newlines are prohibited.
3. Git global options such as `git -c`, unknown external `git-*` programs, `rebase --exec`, `ext::` transports, and options that may launch external programs are prohibited.
4. High-risk operations require explicit confirmation. A `proposalId` is strictly bound to one session and can be executed only once.
5. RPC endpoints accept only JSON POST requests, reject obvious cross-site requests, and limit request-body and identity-field sizes.
6. Common credential formats are redacted from remote URLs and diagnostic output. Always use a Git credential manager; never place tokens in commands or remote URLs.

Security boundaries and known limitations:

- Commands run within the Shell and sandbox policies provided by Harness. The plugin does not expand those policies, but it is not a replacement for host-level permission isolation.
- Git itself may read repository or user configuration and invoke hooks, credential helpers, pagers, transport helpers, or other external programs. Use this plugin only with trusted repositories and trusted Git configuration.
- Proposals are stored in Host memory and are lost when the process restarts. This is not a persistent task queue.
- Manual execution validation is not a terminal audit. For commands without a reliably observable target state, the plugin reports only that a change was detected and does not claim that the command was executed.
- The subcommand allowlist is intentionally conservative. Commands with additional execution surfaces, such as `config` and `submodule`, are not accepted.

Report security vulnerabilities privately by following [SECURITY.md](SECURITY.md). Do not disclose exploit details in a public issue.

## Development and testing

```bash
npm run lint                              # Syntax checks
npm test                                  # Unit and integration tests
npm run check                             # Lint and tests
npm pack --dry-run --ignore-scripts       # Inspect package contents
```

The test suite includes pure-logic unit tests and integration tests that use real temporary Git repositories. It covers command boundaries, risk classification, session isolation, replay prevention, step failure handling, sensitive-data redaction, and manual-execution state transitions. The tests do not access the network.

Project structure:

| Path | Description |
| --- | --- |
| `lib/index.js` | Host plugin, tools, RPC, security validation, and execution |
| `lib/client.js` | Web Client panel |
| `test/unit.test.js` | Unit tests for commands, risk, sessions, and RPC |
| `test/integration.test.js` | Integration tests using real temporary Git repositories |
| `git-guide.cordis.yml` | Automatically merged Cordis patch |

Read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing. Run `npm run check` before publishing; `prepublishOnly` runs the same checks automatically.

## License

[MIT](LICENSE)
