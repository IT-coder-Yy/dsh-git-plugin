/**
 * deepseek-git-guide — Host 半区（静态 Cordis 插件 / npm 包形态）
 *
 * 作为 profile 组合中的一行挂载（见 git-guide.cordis.yml / README），
 * 供 DeepSeek Harness 的所有会话使用。不依赖动态插件的 harness API：
 *   - 工具注册：ctx.tools.register（parameters 为标准 JSON Schema）
 *   - Client→Host 通信：ctx.webServer 路由（POST /git-guide，body.action 分发）
 *
 * 提供的模型工具：
 *   - git_propose    ：理解用户意图 → 校验并登记“最简洁安全”的 git 命令提议（支持多步骤）
 *   - git_execute    ：按 proposalId 执行已登记提议，逐步执行、失败即停；失败附带仓库诊断信息
 *   - git_repo_state ：只读读取仓库现状（分支/状态/最近提交/stash/远程）
 */

const { randomUUID } = require('node:crypto')

const PROPOSALS_PER_SESSION = 3
const MAX_SESSIONS = 100
const MAX_STEPS = 10
const STORED_OUTPUT_MAX_CHARS = 20000
const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const proposalsBySession = new Map()

const ALLOWED_SUBCOMMANDS = new Set([
  'add', 'blame', 'branch', 'cat-file', 'check-attr', 'check-ignore', 'checkout',
  'cherry', 'cherry-pick', 'clean', 'commit', 'count-objects', 'describe', 'diff',
  'fetch', 'for-each-ref', 'fsck', 'grep', 'hash-object', 'log', 'ls-files',
  'ls-tree', 'merge', 'merge-base', 'mv', 'pull', 'push', 'rebase', 'reflog',
  'remote', 'reset', 'restore', 'revert', 'rev-parse', 'rm', 'shortlog', 'show',
  'show-ref', 'stash', 'status', 'switch', 'tag', 'verify-commit',
  'verify-tag', 'whatchanged',
])

const SAFE_SUBCOMMANDS = new Set([
  'blame', 'check-attr', 'check-ignore', 'cherry', 'count-objects', 'describe',
  'diff', 'for-each-ref', 'grep', 'log', 'ls-files', 'ls-tree', 'merge-base',
  'rev-parse', 'shortlog', 'show', 'show-ref', 'status', 'verify-commit',
  'verify-tag', 'whatchanged',
])

function quoteShellArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function parseCommand(command) {
  if (typeof command !== 'string' || command.trim().length === 0) return { ok: false, error: '命令为空' }
  if (command.length > 800) return { ok: false, error: '命令过长（最多 800 字符）' }
  if (/\0|\r|\n/.test(command)) return { ok: false, error: '每个步骤只能包含一条命令，多步操作请使用 steps 数组' }

  const args = []
  let current = ''
  let quote = null
  let started = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      started = true
      continue
    }
    if (quote === '"') {
      if (ch === '"') { quote = null; continue }
      if (ch === '$' || ch === '`') return { ok: false, error: '双引号内不允许 shell 展开（$ 或反引号）' }
      if (ch === '\\') {
        if (i + 1 >= command.length) return { ok: false, error: '命令末尾存在不完整的转义' }
        const next = command[++i]
        current += ['"', '\\', '$', '`'].includes(next) ? next : '\\' + next
      } else current += ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) { args.push(current); current = ''; started = false }
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue }
    if (ch === '\\') {
      if (i + 1 >= command.length) return { ok: false, error: '命令末尾存在不完整的转义' }
      current += command[++i]
      started = true
      continue
    }
    if (';&|<>'.includes(ch)) return { ok: false, error: '命令包含 shell 控制符（; & | < >），多步操作请使用 steps 数组' }
    if (ch === '$' || ch === '`') return { ok: false, error: '命令包含 shell 展开（$ 或反引号）' }
    current += ch
    started = true
  }
  if (quote) return { ok: false, error: '命令包含未闭合的引号' }
  if (started) args.push(current)
  if (args.length < 2 || args[0] !== 'git') return { ok: false, error: '只允许“git <子命令> ...”格式' }
  if (args.length > 80) return { ok: false, error: '命令参数过多（最多 80 个）' }

  const subcommand = args[1]
  if (subcommand.startsWith('-')) return { ok: false, error: '不允许 git 全局选项（如 -c、-C、--exec-path）；请通过 workdir 指定仓库' }
  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
    return { ok: false, error: '不支持 git 子命令「' + subcommand + '」；该限制用于阻止 alias、外部 git-* 程序和可执行脚本入口' }
  }

  const forbiddenOptions = ['--ext-diff', '--textconv', '--open-files-in-pager', '--upload-pack', '--receive-pack']
  for (const arg of args.slice(2)) {
    if (forbiddenOptions.some((opt) => arg === opt || arg.startsWith(opt + '='))) {
      return { ok: false, error: '不允许可能启动外部程序的选项「' + arg + '」' }
    }
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(arg)) {
      return { ok: false, error: '远程 URL 不得内嵌用户名、令牌或密码，请使用凭据管理器' }
    }
    if (/^ext::/i.test(arg)) return { ok: false, error: '不允许 ext:: 远程助手执行外部命令' }
    if (/AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}/.test(arg)) {
      return { ok: false, error: '命令疑似包含访问密钥或令牌，已拒绝登记' }
    }
  }
  const tail = args.slice(2)
  if (['merge', 'pull', 'rebase', 'cherry-pick', 'revert'].includes(subcommand) && tail.some((arg) => /^-s(?:.+)?$/.test(arg) || arg.startsWith('--strategy=') || arg === '--strategy')) {
    return { ok: false, error: '不允许选择自定义 merge strategy，以免启动外部 git-merge-* 程序' }
  }
  if (subcommand === 'push' && tail.some((arg) => arg === '--exec' || arg.startsWith('--exec='))) {
    return { ok: false, error: '不允许 git push --exec 指定远端接收程序' }
  }
  if (subcommand === 'grep' && tail.some((arg) => arg === '-O' || arg.startsWith('-O'))) {
    return { ok: false, error: '不允许 git grep -O 启动 pager 程序' }
  }
  if (subcommand === 'cat-file' && tail.some((arg) => arg === '--filters' || arg.startsWith('--filters='))) {
    return { ok: false, error: '不允许 git cat-file --filters 启动内容过滤程序' }
  }
  if (subcommand === 'rebase' && args.slice(2).some((arg) => arg === '-x' || arg.startsWith('-x') || arg === '--exec' || arg.startsWith('--exec='))) {
    return { ok: false, error: '不允许 git rebase --exec/-x 执行任意 shell 命令' }
  }

  return {
    ok: true,
    args,
    subcommand,
    normalized: args.map(quoteShellArg).join(' '),
  }
}

function validateCommand(command) {
  const parsed = parseCommand(command)
  if (!parsed.ok) return parsed
  return { ...parsed, segments: [command.trim()] }
}

function classifyRisk(command) {
  const parsed = parseCommand(command)
  if (!parsed.ok) return { level: 'hard', reasons: ['命令无法通过安全解析：' + parsed.error] }
  const args = parsed.args
  const sub = parsed.subcommand
  const tail = args.slice(2)
  const reasons = []
  const hasLong = (name) => tail.some((arg) => arg === name || arg.startsWith(name + '='))
  const hasShort = (letter) => tail.some((arg) => /^-[^-]/.test(arg) && arg.slice(1).includes(letter))
  if (sub === 'reset') reasons.push(hasLong('--hard') ? 'git reset --hard 会丢弃工作区未提交的改动' : 'git reset 可能移动分支历史或重置索引')
  if (sub === 'clean' && !hasShort('n') && !hasLong('--dry-run')) reasons.push('git clean 会永久删除未跟踪的文件')
  if (sub === 'push') {
    if (hasShort('f') || hasLong('--force') || hasLong('--force-with-lease') || hasLong('--force-if-includes') || tail.some((arg) => arg.startsWith('+'))) reasons.push('强制推送会覆盖远程分支历史')
    if (hasShort('d') || hasLong('--delete') || hasLong('--mirror') || hasLong('--prune') || tail.some((arg) => arg.startsWith(':'))) reasons.push('该 push 可能删除远程引用')
  }
  if (sub === 'rebase') reasons.push('rebase 会重写提交历史')
  if (sub === 'pull' && hasLong('--rebase')) reasons.push('pull --rebase 会重写本地提交历史')
  if (sub === 'branch' && (hasShort('d') || hasShort('D') || hasShort('f') || hasShort('M') || hasLong('--delete') || hasLong('--force'))) reasons.push('移动、覆盖或删除本地分支可能丢失提交引用')
  if (sub === 'checkout') reasons.push('checkout 可能切换分支、移动分支引用或覆盖工作区文件；建议优先使用 switch/restore')
  if (sub === 'switch' && (hasShort('f') || hasShort('C') || hasLong('--force') || hasLong('--force-create') || hasLong('--discard-changes'))) reasons.push('switch 会丢弃工作区改动或强制移动分支')
  if (sub === 'restore' && (!hasLong('--staged') || hasLong('--worktree'))) reasons.push('git restore 会丢弃工作区改动')
  if (sub === 'rm') reasons.push('git rm 会删除工作区文件并暂存删除操作')
  if (sub === 'stash' && (tail[0] === 'drop' || tail[0] === 'clear')) reasons.push('会删除 stash 记录')
  if (sub === 'commit' && hasLong('--amend')) reasons.push('commit --amend 会重写最近一次提交')
  if (sub === 'reflog' && (tail[0] === 'delete' || tail[0] === 'expire')) reasons.push('会删除或过期 reflog 恢复记录')
  if (sub === 'tag' && (hasShort('d') || hasLong('--delete'))) reasons.push('删除 tag 会移除提交标签')
  if (sub === 'tag' && (hasShort('f') || hasLong('--force'))) reasons.push('强制更新 tag 会移动已有标签')
  if (reasons.length > 0) return { level: 'hard', reasons }
  return SAFE_SUBCOMMANDS.has(sub) ? { level: 'safe', reasons: [] } : { level: 'normal', reasons: [] }
}

function classifyStepsRisk(commands) {
  let level = 'safe'
  const reasons = []
  for (const command of commands) {
    const risk = classifyRisk(command)
    if (risk.level === 'hard') level = 'hard'
    else if (risk.level === 'normal' && level === 'safe') level = 'normal'
    for (const reason of risk.reasons) if (!reasons.includes(reason)) reasons.push(reason)
  }
  return { level, reasons }
}

function sessionIdOf(exec) {
  try {
    const agent = exec && exec.agent
    if (agent && typeof agent.id === 'string' && agent.id.trim() && agent.id.trim().length <= 200) return agent.id.trim()
  } catch (e) { /* ignore */ }
  return null
}

function sessionWorkdir(exec, args, ctx) {
  try {
    if (args && typeof args.workdir === 'string' && args.workdir.trim()) return args.workdir.trim()
  } catch (e) { /* ignore */ }
  try {
    const agent = exec && exec.agent
    const session = agent && agent.session
    const header = session && session.header
    const cwd = (session && session.cwd) || (header && header.cwd)
    if (typeof cwd === 'string' && cwd) return cwd
  } catch (e) { /* ignore */ }
  try {
    const sp = ctx.get('sandboxPolicy')
    if (sp && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot) return sp.workspaceRoot
  } catch (e) { /* ignore */ }
  return undefined
}

async function runGit(shell, workdir, command, timeoutMs, stdoutMaxBytes, signal, policy) {
  try {
    const spec = shell.resolve({ command, workdir, timeoutMs, stdoutMaxBytes, signal, ...(policy ? { sandboxPolicy: policy } : {}) })
    return await shell.run(spec)
  } catch (err) {
    return { exitCode: -1, signal: null, timedOut: false, aborted: false, stdout: { text: '' }, stderr: { text: String((err && err.message) || err) } }
  }
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/(\b[a-z][a-z0-9+.-]{0,19}:\/\/)[^/@\s]+@/gi, '$1***@')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_GITLAB_TOKEN]')
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, '[REDACTED_NPM_TOKEN]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]')
    .replace(/([?&](?:access_token|auth|password|token)=)[^&#\s]+/gi, '$1[REDACTED]')
}

function redactAndLimit(value, maxChars = STORED_OUTPUT_MAX_CHARS) {
  const redacted = redactSecrets(value)
  if (redacted.length <= maxChars) return redacted
  return redacted.slice(0, maxChars) + '\n…[输出已截断]'
}

async function captureFingerprint(shell, workdir) {
  if (!shell) return null
  const command = "echo '--B--'; git branch --show-current 2>&1; echo '--H--'; git rev-parse HEAD 2>&1; echo '--S--'; git status --short 2>&1; echo '--L--'; git log --oneline -3 2>&1; echo '--T--'; git stash list 2>&1"
  const r = await runGit(shell, workdir, command, 15000, 20000)
  return ((r.stdout ? r.stdout.text : '') + (r.stderr ? r.stderr.text : '')).trim()
}

async function captureDiagnostics(shell, workdir) {
  if (!shell) return ''
  const command = "echo '--STATUS--'; git status --short --branch 2>&1; echo '--LOG--'; git log --oneline -3 2>&1; echo '--BRANCH--'; git branch -vv 2>&1; echo '--REMOTE--'; git remote -v 2>&1"
  const r = await runGit(shell, workdir, command, 15000, 20000)
  return redactAndLimit(((r.stdout ? r.stdout.text : '') + (r.stderr ? r.stderr.text : '')).trim())
}

function addPathsOf(cmd) {
  const parsed = parseCommand(cmd)
  if (!parsed.ok || parsed.subcommand !== 'add') return null
  const tail = parsed.args.slice(2)
  if (tail.some((arg) => ['-A', '--all', '-u', '--update', '--refresh', '--renormalize', '--pathspec-from-file'].some((opt) => arg === opt || arg.startsWith(opt + '=')))) return ''
  const separator = tail.indexOf('--')
  const paths = separator >= 0 ? tail.slice(separator + 1) : tail.filter((arg) => !arg.startsWith('-'))
  return paths.join(' ')
}

function deriveChecks(commands) {
  const parsedCommands = commands.map(parseCommand).filter((p) => p.ok)
  const hasCommit = parsedCommands.some((p) => p.subcommand === 'commit')
  const checks = []
  let lastBranch = null
  let lastCommitMsg = null
  const branchesGone = []
  let lastStaged = []
  let lastClean = []
  let stashOp = null
  let hasPush = false
  for (const parsed of parsedCommands) {
    const tail = parsed.args.slice(2)
    if (parsed.subcommand === 'switch' || parsed.subcommand === 'checkout') {
      const createOptions = parsed.subcommand === 'switch'
        ? ['-c', '-C', '--create', '--force-create']
        : ['-b', '-B']
      for (let i = 0; i < tail.length - 1; i++) {
        if (createOptions.includes(tail[i])) lastBranch = tail[i + 1]
      }
    }
    if (parsed.subcommand === 'commit') {
      for (let i = 0; i < tail.length; i++) {
        if ((tail[i] === '-m' || tail[i] === '--message') && i + 1 < tail.length) { lastCommitMsg = tail[i + 1]; break }
        if (tail[i].startsWith('--message=')) { lastCommitMsg = tail[i].slice('--message='.length); break }
      }
    }
    if (parsed.subcommand === 'branch') {
      const deleteAt = tail.findIndex((arg) => arg === '-d' || arg === '-D' || arg === '--delete')
      if (deleteAt >= 0) branchesGone.push(...tail.slice(deleteAt + 1).filter((arg) => !arg.startsWith('-')))
    }
    if (!hasCommit && parsed.subcommand === 'add') {
      const paths = addPathsOf(parsed.args.map(quoteShellArg).join(' '))
      const separator = tail.indexOf('--')
      if (paths) lastStaged = separator >= 0 ? tail.slice(separator + 1) : tail.filter((arg) => !arg.startsWith('-'))
    }
    if (parsed.subcommand === 'checkout' || parsed.subcommand === 'restore') {
      const separator = tail.indexOf('--')
      if (separator >= 0) lastClean = tail.slice(separator + 1)
      else if (parsed.subcommand === 'restore' && !tail.some((arg) => arg === '--staged' || arg.startsWith('--staged='))) {
        lastClean = tail.filter((arg) => !arg.startsWith('-'))
      }
    }
    if (parsed.subcommand === 'stash' && (tail[0] === 'push' || tail.length === 0)) stashOp = 'nonempty'
    if (parsed.subcommand === 'stash' && (tail[0] === 'drop' || tail[0] === 'clear')) stashOp = 'empty'
    if (parsed.subcommand === 'push') hasPush = true
  }
  if (lastBranch) checks.push({ type: 'branch', value: lastBranch, label: '当前分支应为 ' + lastBranch })
  if (lastCommitMsg !== null) checks.push({ type: 'commit-msg', value: lastCommitMsg, label: '最近提交信息应为「' + lastCommitMsg + '」' })
  for (const branch of branchesGone) checks.push({ type: 'branch-gone', value: branch, label: '分支 ' + branch + ' 应已删除' })
  if (lastStaged.length) checks.push({ type: 'staged', value: lastStaged, label: '指定文件应已暂存' })
  if (lastClean.length) checks.push({ type: 'clean', value: lastClean, label: '指定文件的工作区改动应已丢弃' })
  if (stashOp === 'nonempty') checks.push({ type: 'stash-nonempty', value: true, label: 'stash 应非空' })
  if (stashOp === 'empty') checks.push({ type: 'stash-empty', value: true, label: 'stash 应为空' })
  if (hasPush) checks.push({ type: 'no-ahead', value: true, label: '应已推送（不再领先远程）' })
  return checks
}

async function runChecks(shell, workdir, checks) {
  const failed = []
  for (const c of checks) {
    let pass = false
    try {
      if (c.type === 'branch') {
        const r = await runGit(shell, workdir, 'git branch --show-current', 10000, 4096)
        pass = (r.stdout ? r.stdout.text : '').trim() === c.value
      } else if (c.type === 'commit-msg') {
        const r = await runGit(shell, workdir, 'git log -1 --pretty=%s', 10000, 4096)
        pass = (r.stdout ? r.stdout.text : '').trim() === c.value
      } else if (c.type === 'staged') {
        const paths = Array.isArray(c.value) ? c.value : String(c.value).split(/\s+/).filter(Boolean)
        pass = true
        for (const path of paths) {
          const r = await runGit(shell, workdir, 'git diff --cached --quiet -- ' + quoteShellArg(path), 10000, 4096)
          if (r.exitCode !== 1) { pass = false; break }
        }
      } else if (c.type === 'branch-gone') {
        const r = await runGit(shell, workdir, 'git branch --list ' + quoteShellArg(c.value), 10000, 4096)
        pass = (r.stdout ? r.stdout.text : '').trim() === ''
      } else if (c.type === 'stash-nonempty') {
        const r = await runGit(shell, workdir, 'git stash list', 10000, 4096)
        pass = (r.stdout ? r.stdout.text : '').trim().length > 0
      } else if (c.type === 'stash-empty') {
        const r = await runGit(shell, workdir, 'git stash list', 10000, 4096)
        pass = (r.stdout ? r.stdout.text : '').trim().length === 0
      } else if (c.type === 'clean') {
        const paths = Array.isArray(c.value) ? c.value : String(c.value).split(/\s+/).filter(Boolean)
        const r = await runGit(shell, workdir, 'git status --porcelain -- ' + paths.map(quoteShellArg).join(' '), 10000, 4096)
        pass = r.exitCode === 0 && (r.stdout ? r.stdout.text : '').trim() === ''
      } else if (c.type === 'no-ahead') {
        const r = await runGit(shell, workdir, 'git rev-list --count @{u}..HEAD 2>&1', 10000, 4096)
        pass = (r.stdout ? r.stdout.text : '').trim() === '0'
      }
    } catch (e) { pass = false }
    if (!pass) failed.push(c.label)
  }
  return failed
}

async function verifyProposal(shell, proposal) {
  const now = await captureFingerprint(shell, proposal.workdir)
  const changed = now !== null && proposal.fingerprint !== null && now !== proposal.fingerprint
  const visibleState = redactAndLimit(now || '')
  const checks = deriveChecks(proposal.steps.map((s) => s.command))
  if (checks.length === 0) {
    return {
      changed,
      verified: false,
      partial: changed,
      message: changed
        ? '检测到仓库状态变化，但该命令没有可可靠比对的目标状态，无法确认变化来自本建议'
        : '未检测到仓库状态变化，看起来还没有执行',
      changedState: changed ? visibleState : '',
    }
  }

  const failed = await runChecks(shell, proposal.workdir, checks)
  const baselineFailed = Array.isArray(proposal.baselineFailed) ? proposal.baselineFailed : []
  const transitioned = baselineFailed.length > 0 && failed.length === 0
  if (transitioned) return { changed, verified: true, partial: false, message: '', changedState: visibleState }
  if (failed.length === 0) {
    return {
      changed,
      verified: false,
      partial: changed,
      message: '复制命令时目标状态已经满足，无法据此确认本次是否执行；请在终端核对结果',
      changedState: changed ? visibleState : '',
    }
  }
  const progress = changed || failed.length < baselineFailed.length
  return {
    changed,
    verified: false,
    partial: progress,
    message: (progress ? '检测到状态变化，但预期结果尚未全部达成：' : '未检测到预期结果：') + failed.join('；'),
    changedState: changed ? visibleState : '',
  }
}

async function executeProposalSteps(shell, proposal, signal, policy) {
  let ok = true
  const stepsResult = []
  for (const step of proposal.steps) {
    const validated = validateCommand(step.command)
    if (!validated.ok) {
      step.result = { ok: false, exitCode: -1, signal: '', timedOut: false, stdout: '', stderr: validated.error }
      stepsResult.push({ command: step.command, ok: false, exitCode: -1 })
      ok = false
      break
    }
    const r = await runGit(shell, proposal.workdir, validated.normalized, 120000, 100000, signal, policy)
    const sok = r.exitCode === 0
    step.result = {
      ok: sok,
      exitCode: r.exitCode === null ? -1 : r.exitCode,
      signal: r.signal || '',
      timedOut: r.timedOut,
      stdout: redactAndLimit(r.stdout ? r.stdout.text : ''),
      stderr: redactAndLimit(r.stderr ? r.stderr.text : ''),
    }
    stepsResult.push({ command: step.command, ok: sok, exitCode: step.result.exitCode })
    if (!sok) { ok = false; break }
  }
  proposal.result = { ok }
  return { ok, stepsResult }
}

function executionError(proposal, error) {
  return {
    ok: false,
    proposalId: proposal ? proposal.proposalId : '',
    command: proposal ? proposal.command : '',
    steps: [],
    exitCode: -1,
    signal: '',
    timedOut: false,
    stdout: '',
    stderr: '',
    diagnostics: '',
    error,
  }
}

async function executeRegisteredProposal(shell, proposal, signal, policy) {
  if (!proposal) return executionError(null, '找不到该提议（proposalId 无效或已过期）')
  if (proposal.closed === true || proposal.status === 'succeeded' || proposal.status === 'failed' || proposal.status === 'verified' || proposal.status === 'dismissed') {
    return executionError(proposal, '该提议已经结束，不能重复执行；如需重试，请创建新的提议')
  }
  if (proposal.status === 'running') return executionError(proposal, '该提议正在执行，请勿重复提交')
  if (!shell) return executionError(proposal, 'shell 服务不可用')

  proposal.status = 'running'
  proposal.startedAt = Date.now()
  const { ok, stepsResult } = await executeProposalSteps(shell, proposal, signal, policy)
  proposal.status = ok ? 'succeeded' : 'failed'
  proposal.finishedAt = Date.now()
  const last = proposal.steps[proposal.steps.length - 1]
  const failedStep = proposal.steps.find((s) => s.result && s.result.ok === false)
  const lastResult = failedStep ? failedStep.result : (last ? last.result : null)
  const diagnostics = ok ? '' : await captureDiagnostics(shell, proposal.workdir)
  const recovery = ok ? null : buildRecovery(proposal, failedStep, diagnostics)
  if (recovery && recovery.command) {
    const corrected = registerRecoveryProposal(proposal, recovery)
    if (corrected) recovery.proposalId = corrected.proposalId
  }
  return {
    ok,
    proposalId: proposal.proposalId,
    command: proposal.command,
    steps: stepsResult,
    exitCode: lastResult ? lastResult.exitCode : -1,
    signal: lastResult ? lastResult.signal : '',
    timedOut: lastResult ? lastResult.timedOut : false,
    stdout: redactSecrets(lastResult ? lastResult.stdout : ''),
    stderr: redactSecrets(lastResult ? lastResult.stderr : ''),
    diagnostics,
    recovery: recovery ? { suggestion: recovery.suggestion, command: recovery.command || '', proposalId: recovery.proposalId || null } : null,
    error: ok ? '' : redactSecrets((failedStep && (failedStep.result.stderr || failedStep.result.stdout)) || 'git 退出码 ' + (lastResult ? lastResult.exitCode : -1)),
  }
}

/**
 * 依据失败步骤的输出与仓库诊断，推导一条能完成用户意图的修正命令。
 * 返回 { suggestion, command }；command 为 null 表示需要人工处理（无法安全自动改写）。
 */
function buildRecovery(proposal, failedStep, diagnostics) {
  if (!failedStep || !failedStep.result) return null
  const text = String(((failedStep.result.stderr || '') + ' ' + (failedStep.result.stdout || '') + ' ' + (diagnostics || '')).trim())
  const cmd = String(failedStep.command || '')

  // 1) 执行环境只读（沙箱/挂载）——命令本身没错，改执行环境
  if (/只读文件系统|read-only file system|EROFS|cannot lock ref|cannot create .*\.lock/i.test(text)) {
    return { suggestion: '执行环境对目标目录只读（沙箱策略或挂载问题）：请在终端手动执行该命令，或调整执行环境的沙箱权限。', command: null }
  }
  // 2) 被 .gitignore 忽略 → add 加 -f
  if (/(\.gitignore|被忽略|ignored by your|did not match any files|没有匹配任何文件)/i.test(text) && /git\s+add\b/.test(cmd)) {
    const corrected = cmd.replace(/git\s+add\s+/, 'git add -f ')
    if (corrected !== cmd) return { suggestion: '目标文件被 .gitignore 忽略：改用 -f 强制加入（仅针对明确列出的文件）。', command: corrected }
  }
  // 3) 建分支时分支已存在 → 改为切换
  if (/already exists|分支.*已存在|already exist/i.test(text)) {
    const m = cmd.match(/git\s+(?:switch\s+-c|checkout\s+-b)\s+([^\s]+)/)
    if (m) {
      const corrected = cmd.replace(/switch\s+-c/, 'switch').replace(/checkout\s+-b/, 'checkout')
      return { suggestion: '分支 ' + m[1] + ' 已存在：改为切换到现有分支（或换一个分支名）。', command: corrected }
    }
  }
  // 4) 不是 git 仓库
  if (/not a git repository|不是.*git 仓库|不是一个 git 仓库/i.test(text)) {
    return { suggestion: '目标目录不是 git 仓库：确认 workdir 指向仓库根目录，或先 git init。', command: null }
  }
  // 5) SSH / 远程连接
  if (/Bad owner or permissions|Could not resolve hostname|Permission denied \(publickey\)|ssh:|Connection (refused|timed out)/i.test(text)) {
    return { suggestion: 'SSH/远程连接失败：检查 ssh 配置与密钥（配置文件权限、密钥是否被授权），可临时用 git -c core.sshCommand 覆盖 ssh 参数。', command: null }
  }
  // 6) 推送被拒
  if (/(rejected|failed to push|non-fast-forward|远程.*拒绝|推送.*失败)/i.test(text) && /git\s+push\b/.test(cmd)) {
    return { suggestion: '推送被拒绝：先 git pull --rebase 同步远程再重试；若确认要覆盖远程历史，需明确确认后使用 --force-with-lease（高风险）。', command: null }
  }
  // 7) 无可提交内容
  if (/(nothing to commit|没有.*要提交|nothing added to commit)/i.test(text) && /git\s+commit\b/.test(cmd)) {
    return { suggestion: '没有可提交的改动：先 git add 暂存文件（注意被 .gitignore 忽略的文件需 -f）。', command: null }
  }
  // 8) 合并冲突
  if (/CONFLICT|冲突|conflict/i.test(text)) {
    return { suggestion: '存在合并冲突：先解决冲突文件，再 git add 标记为已解决，最后 git commit 完成合并。', command: null }
  }
  // 9) 缺少上游跟踪
  if (/(No upstream|no upstream|没有上游|no tracking)/i.test(text)) {
    return { suggestion: '分支没有上游跟踪：用 git push -u origin <分支名> 建立跟踪后重试。', command: null }
  }
  return null
}

/** 把修正命令登记为新的待执行提议（同一会话），返回该提议或 null。 */
function registerRecoveryProposal(failedProposal, recovery) {
  const v = validateCommand(recovery.command)
  if (!v.ok) return null
  const sessionId = failedProposal.sessionId
  const prev = proposalsBySession.get(sessionId)
  if (prev && prev.some((p) => p.status === 'running')) return null
  const risk = classifyRisk(recovery.command)
  const proposal = {
    proposalId: 'g-' + randomUUID(),
    sessionId,
    intent: '修正建议：' + recovery.suggestion,
    command: recovery.command.trim(),
    steps: [{ command: recovery.command.trim(), result: null }],
    explanation: recovery.suggestion + '（由执行失败自动生成，请确认后执行）',
    risk: risk.level,
    reasons: risk.reasons,
    confirmed: false,
    workdir: failedProposal.workdir,
    createdAt: Date.now(),
    result: null,
    closed: false,
    copied: false,
    fingerprint: null,
    verified: false,
    status: 'pending',
    recovery: true,
  }
  if (prev) for (const pp of prev) { if (!(pp.closed === true)) pp.closed = true }
  storeProposal(sessionId, proposal)
  console.log('git-guide 修正建议登记', proposal.proposalId, 'session=', sessionId, 'risk=', risk.level)
  return proposal
}

function storeProposal(sessionId, p) {
  pruneProposalSessions()
  let list = proposalsBySession.get(sessionId)
  if (!list) {
    list = []
    proposalsBySession.set(sessionId, list)
  } else {
    proposalsBySession.delete(sessionId)
    proposalsBySession.set(sessionId, list)
  }
  list.unshift(p)
  if (list.length > PROPOSALS_PER_SESSION) list.length = PROPOSALS_PER_SESSION
  while (proposalsBySession.size > MAX_SESSIONS) {
    const oldest = [...proposalsBySession].find(([, entries]) => entries.every((proposal) => proposal.status !== 'running'))?.[0]
    if (oldest === undefined) break
    proposalsBySession.delete(oldest)
  }
  return p
}

function pruneProposalSessions(now = Date.now()) {
  for (const [sessionId, entries] of proposalsBySession) {
    const newest = entries[0]
    if (!newest || (now - newest.createdAt > SESSION_TTL_MS && entries.every((p) => p.status !== 'running'))) {
      proposalsBySession.delete(sessionId)
    }
  }
}

function findProposal(sessionId, proposalId) {
  if (!proposalId) return undefined
  pruneProposalSessions()
  const list = proposalsBySession.get(sessionId)
  return list ? list.find((x) => x.proposalId === proposalId) : undefined
}

function proposalView(p) {
  return {
    proposalId: p.proposalId,
    intent: p.intent,
    command: p.command,
    steps: p.steps.map((s) => ({ command: s.command, result: s.result })),
    explanation: p.explanation,
    risk: p.risk,
    reasons: p.reasons,
    confirmed: p.confirmed,
    workdir: p.workdir,
    result: p.result,
    closed: p.closed === true,
    copied: p.copied === true,
    status: p.status || (p.closed ? 'dismissed' : 'pending'),
  }
}

function latestPending(sessionId) {
  pruneProposalSessions()
  const list = proposalsBySession.get(sessionId)
  if (list) {
    for (const p of list) if (!(p.closed === true)) return p
  }
  return null
}

/** 读取 HTTP 请求体（上限 1MB）；超限返回 null，其他失败返回空串。 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (c) => {
      size += c.length
      if (size > 1024 * 1024) { chunks.length = 0; finish(null); return }
      if (settled) return
      chunks.push(c)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(''))
  })
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(data))
}

module.exports = {
  name: 'git-guide',
  inject: ['shell', 'tools'],
  apply(ctx) {
    const shell = ctx.get('shell')
    const tools = ctx.get('tools')
    const sandboxPolicy = ctx.get('sandboxPolicy')

    if (tools) {
      tools.register({
        name: 'git_propose',
        description: '当用户用自然语言描述一个想做的 git 操作（但不知道/不确定具体命令）时，调用本工具提出命令建议并登记为可执行提议。用法：1)（可选）先调用 git_repo_state 了解仓库现状；2) 分析用户意图，选择最简洁、最安全、副作用最小的纯 git 命令；3) 给出清晰的中文解释。多条命令请用 steps 数组分开传入（如 ["git add -A", "git commit -m \\"msg\\""]），不要用 && 拼成一条 —— 插件会逐步执行、逐步校验、失败即停；单条命令用 command。工具会做安全校验并登记提议（新提议会自动顶替同会话旧的待处理提议），返回 proposalId。之后把命令和解释展示给用户，并让用户选择：直接执行 → 调用 git_execute(proposalId)；手动执行 → 让用户复制命令自行执行（面板会自动按预期结果校验）。若返回 needsConfirm: true，说明命令属于高风险（如 reset --hard、force push、rebase、clean -fd 等），必须向用户说明风险、获得明确同意后，再以 confirm: true 重新调用本工具登记。',
        parameters: {
          type: 'object',
          properties: {
            intent: { type: 'string', maxLength: 500, description: '用户想要完成的 git 操作意图（自然语言，简短描述）' },
            command: { type: 'string', maxLength: 800, description: '单条 git 命令（steps 为空时必填）。只允许固定白名单内的纯 git 子命令，不允许全局选项、管道、重定向或 shell 展开' },
            steps: { type: 'array', maxItems: MAX_STEPS, items: { type: 'string', maxLength: 800 }, description: '多条 git 命令按执行顺序分开传入（推荐，代替 && 拼接）；每条单独校验、逐步执行、失败即停' },
            explanation: { type: 'string', maxLength: 4000, description: '为什么用这些命令：它们做什么、为什么最简洁安全、有什么副作用' },
            workdir: { type: 'string', maxLength: 4096, description: 'git 仓库目录（绝对路径）。省略时使用当前会话的工作目录' },
            confirm: { type: 'boolean', description: '仅当命令属于高风险（hard）时使用：true 表示用户已明确知晓风险并同意执行。未获用户明确同意前必须省略或传 false' },
          },
          required: ['intent', 'explanation'],
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              proposalId: { type: 'string' },
              intent: { type: 'string' },
              command: { type: 'string' },
              steps: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' } }, additionalProperties: false } },
              explanation: { type: 'string' },
              risk: { type: 'string', enum: ['safe', 'normal', 'hard'] },
              reasons: { type: 'array', items: { type: 'string' } },
              needsConfirm: { type: 'boolean' },
              workdir: { type: 'string' },
              error: { type: 'string' },
            },
            additionalProperties: false,
          },
          render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
        },
        async execute(args, exec) {
          const sessionId = sessionIdOf(exec)
          if (!sessionId) {
            return { ok: false, proposalId: '', intent: String((args && args.intent) || ''), command: '', steps: [], explanation: String((args && args.explanation) || ''), risk: 'normal', reasons: [], needsConfirm: false, workdir: '', error: '当前工具调用缺少会话身份，拒绝创建无法隔离的提议' }
          }
          args = args || {}
          if (String(args.intent || '').length > 500 || String(args.explanation || '').length > 4000 || String(args.workdir || '').length > 4096) {
            return { ok: false, proposalId: '', intent: '', command: '', steps: [], explanation: '', risk: 'normal', reasons: [], needsConfirm: false, workdir: '', error: '输入过长：intent 最多 500 字符、explanation 最多 4000 字符、workdir 最多 4096 字符' }
          }
          const workdir = sessionWorkdir(exec, args, ctx)
          const rawCommands = Array.isArray(args.steps) && args.steps.length ? args.steps : (args.command ? [args.command] : [])
          if (rawCommands.length === 0) {
            return { ok: false, proposalId: '', intent: String(args.intent || ''), command: '', steps: [], explanation: String(args.explanation || ''), risk: 'normal', reasons: [], needsConfirm: false, workdir: workdir || '', error: 'command 或 steps 至少提供一个' }
          }
          if (rawCommands.length > MAX_STEPS) {
            return { ok: false, proposalId: '', intent: String(args.intent || ''), command: '', steps: [], explanation: String(args.explanation || ''), risk: 'normal', reasons: [], needsConfirm: false, workdir: workdir || '', error: '步骤过多（最多 ' + MAX_STEPS + ' 步）' }
          }
          const steps = []
          for (const raw of rawCommands) {
            const v = validateCommand(raw)
            if (!v.ok) {
              return { ok: false, proposalId: '', intent: String(args.intent || ''), command: String(raw), steps: [], explanation: String(args.explanation || ''), risk: 'normal', reasons: [], needsConfirm: false, workdir: workdir || '', error: '步骤「' + raw + '」校验失败：' + v.error }
            }
            steps.push({ command: String(raw).trim(), result: null })
          }
          if (steps.length === 0) {
            return { ok: false, proposalId: '', intent: String(args.intent || ''), command: '', steps: [], explanation: String(args.explanation || ''), risk: 'normal', reasons: [], needsConfirm: false, workdir: workdir || '', error: '没有可执行的命令步骤' }
          }
          if (shell) {
            const r = await runGit(shell, workdir, 'git rev-parse --show-toplevel', 15000, 4096, exec.signal)
            if (r.exitCode !== 0) {
              const errText = ((r.stderr && r.stderr.text) + ' ' + (r.stdout && r.stdout.text)).trim()
              return { ok: false, proposalId: '', intent: String(args.intent || ''), command: steps.map((s) => s.command).join(' && '), steps: steps.map((s) => ({ command: s.command })), explanation: String(args.explanation || ''), risk: 'normal', reasons: [], needsConfirm: false, workdir: workdir || '', error: '目标目录不是 git 仓库（workdir=' + (workdir || '默认工作目录') + '）：' + errText.slice(0, 200) }
            }
          }
          const commandTexts = steps.map((s) => s.command)
          const risk = classifyStepsRisk(commandTexts)
          const confirmed = args.confirm === true
          const prev = proposalsBySession.get(sessionId)
          if (prev && prev.some((proposal) => proposal.status === 'running')) {
            return { ok: false, proposalId: '', intent: String(args.intent || ''), command: '', steps: [], explanation: String(args.explanation || ''), risk: risk.level, reasons: risk.reasons, needsConfirm: false, workdir: workdir || '', error: '同一会话已有提议正在执行，请等待执行结束后再创建新提议' }
          }
          if (prev) for (const pp of prev) { if (!(pp.closed === true)) pp.closed = true }
          const proposal = {
            proposalId: 'g-' + randomUUID(),
            sessionId,
            intent: String(args.intent || ''),
            command: commandTexts.join(' && '),
            steps,
            explanation: String(args.explanation || ''),
            risk: risk.level,
            reasons: risk.reasons,
            confirmed,
            workdir: workdir || '',
            createdAt: Date.now(),
            result: null,
            closed: false,
            copied: false,
            fingerprint: null,
            verified: false,
            status: 'pending',
          }
          storeProposal(sessionId, proposal)
          const needsConfirm = risk.level === 'hard' && !confirmed
          console.log('git_propose 登记', proposal.proposalId, 'session=', sessionId, 'risk=', risk.level, 'steps=', steps.length)
          return { ok: true, proposalId: proposal.proposalId, intent: proposal.intent, command: proposal.command, steps: steps.map((s) => ({ command: s.command })), explanation: proposal.explanation, risk: risk.level, reasons: risk.reasons, needsConfirm, workdir: proposal.workdir, error: '' }
        },
      })

      tools.register({
        name: 'git_execute',
        description: '执行一条已由 git_propose 登记并通过安全校验的提议（按 proposalId 执行，不接受任意命令）。按步骤顺序执行，任一步失败即停止，返回每步结果；失败时还会附带仓库诊断信息（状态/最近提交/分支跟踪/远程），供你判断原因。仅当用户明确选择“直接执行”时才调用。高风险（hard）命令执行时必须同时传 confirm: true，且只能在用户已明确同意后传。重要：若执行失败，不要只报告失败就结束 —— 请依据 error/stdout/stderr/diagnostics 分析失败原因（例如 SSH 或远程配置错误、文件被 .gitignore 忽略、分支已存在、推送被拒绝、合并冲突等），然后调用 git_propose 提出一条仍能通过安全校验的修正命令（例如调整参数、补上未执行的步骤、先解决冲突等），向用户确认后再执行。全部成功则该提议自动关闭（面板回到空闲）。执行后把结果汇报给用户。',
        parameters: {
          type: 'object',
          properties: {
            proposalId: { type: 'string', description: 'git_propose 返回的 proposalId' },
            confirm: { type: 'boolean', description: '高风险命令执行时必须为 true，代表用户此刻的明确同意' },
          },
          required: ['proposalId'],
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              proposalId: { type: 'string' },
              command: { type: 'string' },
              steps: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, ok: { type: 'boolean' }, exitCode: { type: 'integer' } }, additionalProperties: false } },
              exitCode: { type: 'integer' },
              signal: { type: 'string' },
              timedOut: { type: 'boolean' },
              stdout: { type: 'string' },
              stderr: { type: 'string' },
              diagnostics: { type: 'string' },
              recovery: { type: 'object', properties: { suggestion: { type: 'string' }, command: { type: 'string' }, proposalId: { type: 'string' } }, additionalProperties: false },
              error: { type: 'string' },
            },
            additionalProperties: false,
          },
          render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
        },
        async execute(args, exec) {
          args = args || {}
          const sessionId = sessionIdOf(exec)
          if (!sessionId) return executionError(null, '当前工具调用缺少会话身份，拒绝执行无法隔离的提议')
          const policy = sandboxPolicy ? sandboxPolicy.resolve({ session: exec.agent && exec.agent.session }) : undefined
          const proposal = findProposal(sessionId, args.proposalId)
          if (!proposal) return { ok: false, proposalId: String(args.proposalId || ''), command: '', steps: [], exitCode: -1, signal: '', timedOut: false, stdout: '', stderr: '', diagnostics: '', error: '找不到该提议（proposalId 无效或已过期）' }
          if (proposal.risk === 'hard' && args.confirm !== true) {
            return { ok: false, proposalId: proposal.proposalId, command: proposal.command, steps: [], exitCode: -1, signal: '', timedOut: false, stdout: '', stderr: '', diagnostics: '', error: '高风险命令需要用户明确同意后才能执行：请先向用户说明风险（' + proposal.reasons.join('；') + '），获得同意后以 confirm: true 重新调用' }
          }
          const result = await executeRegisteredProposal(shell, proposal, exec.signal, policy)
          if (result.ok) proposal.closed = true
          console.log('git_execute 执行', proposal.proposalId, 'ok=', result.ok, 'steps=', result.steps.length, result.ok ? '已关闭' : '已结束')
          return result
        },
      })

      tools.register({
        name: 'git_repo_state',
        description: '读取当前 git 仓库的只读状态（顶层目录、当前分支、工作区状态、最近提交、stash、远程），用于在提出命令建议前了解仓库现状。只读，不修改任何东西。',
        parameters: {
          type: 'object',
          properties: {
            workdir: { type: 'string', description: 'git 仓库目录（绝对路径）。省略时使用当前会话的工作目录' },
          },
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              isRepo: { type: 'boolean' },
              workdir: { type: 'string' },
              topLevel: { type: 'string' },
              branch: { type: 'string' },
              status: { type: 'string' },
              recentCommits: { type: 'string' },
              stashes: { type: 'string' },
              remotes: { type: 'string' },
              error: { type: 'string' },
            },
            additionalProperties: false,
          },
          render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
        },
        async execute(args, exec) {
          const workdir = sessionWorkdir(exec, args, ctx)
          if (!shell) return { ok: false, isRepo: false, workdir: workdir || '', topLevel: '', branch: '', status: '', recentCommits: '', stashes: '', remotes: '', error: 'shell 服务不可用' }
          const command = "echo '__TOP__'; git rev-parse --show-toplevel 2>&1; echo '__BRANCH__'; git branch --show-current 2>&1; echo '__STATUS__'; git status --short --branch 2>&1; echo '__LOG__'; git log --oneline -8 2>&1; echo '__STASH__'; git stash list 2>&1; echo '__REMOTE__'; git remote -v 2>&1"
          const r = await runGit(shell, workdir, command, 20000, 30000, exec.signal)
          const text = (r.stdout ? r.stdout.text : '') + (r.stderr ? r.stderr.text : '')
          const keys = ['__TOP__', '__BRANCH__', '__STATUS__', '__LOG__', '__STASH__', '__REMOTE__']
          const parts = {}
          let idx = 0
          for (let k = 0; k < keys.length; k++) {
            const start = text.indexOf(keys[k], idx)
            if (start < 0) { parts[keys[k]] = ''; continue }
            const valueStart = start + keys[k].length
            const nextKey = keys[k + 1]
            const end = nextKey ? text.indexOf(nextKey, valueStart) : text.length
            parts[keys[k]] = end < 0 ? text.slice(valueStart) : text.slice(valueStart, end)
            idx = end < 0 ? text.length : end
          }
          const top = parts['__TOP__'].trim()
          const isRepo = /^\/|^[A-Za-z]:[\\/]/.test(top)
          return {
            ok: true,
            isRepo,
            workdir: workdir || '',
            topLevel: top,
            branch: redactAndLimit(parts['__BRANCH__'].trim(), 4096),
            status: redactAndLimit(parts['__STATUS__'].trim()),
            recentCommits: redactAndLimit(parts['__LOG__'].trim()),
            stashes: redactAndLimit(parts['__STASH__'].trim()),
            remotes: redactAndLimit(parts['__REMOTE__'].trim()),
            error: '',
          }
        },
      })
    }

    // Client→Host 通信：POST /git-guide，body.action 分发（body 上限 1MB）
    const registerWebServer = (webServer) => {
      if (!webServer) return undefined
      return webServer.register({
        kind: 'prefix',
        path: '/git-guide',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const fetchSite = req.headers && req.headers['sec-fetch-site']
          if (fetchSite === 'cross-site') {
            sendJson(res, 403, { ok: false, error: 'cross-site request denied' })
            return
          }
          const contentType = req.headers && req.headers['content-type']
          if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
            sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
            return
          }
          let body = {}
          try {
            const raw = await readBody(req)
            if (raw === null) {
              sendJson(res, 413, { ok: false, error: 'request body too large' })
              return
            }
            body = raw ? JSON.parse(raw) : {}
          } catch (e) {
            sendJson(res, 400, { ok: false, error: 'invalid json body' })
            return
          }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
          if (!sessionId || sessionId.length > 200) {
            sendJson(res, 400, { ok: false, error: 'valid sessionId is required' })
            return
          }
          const action = typeof body.action === 'string' ? body.action : ''
          try {
            if (action === 'state') {
              const p = latestPending(sessionId)
              if (p && p.status === 'pending' && p.copied === true && p.fingerprint) {
                const v = await verifyProposal(shell, p)
                if (v.verified) {
                  p.verified = true
                  p.status = 'verified'
                }
                sendJson(res, 200, { ok: true, proposal: proposalView(p), changed: v.changed, verified: v.verified, partial: v.partial, message: v.message, changedState: v.changedState })
              } else {
                sendJson(res, 200, { ok: true, proposal: p ? proposalView(p) : null, changed: false, verified: false, partial: false, message: '', changedState: '' })
              }
              return
            }
            if (action === 'dismiss') {
              const proposal = findProposal(sessionId, body.proposalId)
              if (!proposal) { sendJson(res, 200, { ok: false, error: '找不到该提议' }); return }
              if (proposal.status === 'running') { sendJson(res, 200, { ok: false, error: '该提议正在执行，不能放弃' }); return }
              proposal.closed = true
              proposal.status = 'dismissed'
              proposal.manual = body.manual === true
              sendJson(res, 200, { ok: true })
              return
            }
            if (action === 'mark-copied') {
              const proposal = findProposal(sessionId, body.proposalId)
              if (!proposal) { sendJson(res, 200, { ok: false, error: '找不到该提议' }); return }
              if (proposal.status !== 'pending') { sendJson(res, 200, { ok: false, error: '该提议已不再等待执行' }); return }
              if (proposal.risk === 'hard' && body.confirm !== true) { sendJson(res, 200, { ok: false, error: '高风险操作：请先勾选“我已了解风险”再复制' }); return }
              const fingerprint = await captureFingerprint(shell, proposal.workdir)
              const checks = deriveChecks(proposal.steps.map((s) => s.command))
              const baselineFailed = await runChecks(shell, proposal.workdir, checks)
              proposal.fingerprint = fingerprint
              proposal.baselineFailed = baselineFailed
              proposal.copied = true
              sendJson(res, 200, { ok: true })
              return
            }
            if (action === 'verify') {
              const proposal = findProposal(sessionId, body.proposalId)
              if (!proposal) { sendJson(res, 200, { ok: false, error: '找不到该提议' }); return }
              if (proposal.status !== 'pending') { sendJson(res, 200, { ok: false, changed: false, verified: false, partial: false, message: '该提议已不再等待手动验证', changedState: '' }); return }
              if (proposal.copied !== true || !proposal.fingerprint) {
                sendJson(res, 200, { ok: true, changed: false, verified: false, partial: false, message: '尚未复制命令或缺少对比基线', changedState: '' })
                return
              }
              const v = await verifyProposal(shell, proposal)
              if (v.verified) {
                proposal.verified = true
                proposal.status = 'verified'
              }
              sendJson(res, 200, { ok: true, changed: v.changed, verified: v.verified, partial: v.partial, message: v.message, changedState: v.changedState })
              return
            }
            if (action === 'execute') {
              const proposal = findProposal(sessionId, body.proposalId)
              if (!proposal) { sendJson(res, 200, { ok: false, proposalId: body.proposalId || '', command: '', steps: [], exitCode: -1, signal: '', timedOut: false, stdout: '', stderr: '', diagnostics: '', error: '找不到该提议（proposalId 无效或已过期）' }); return }
              if (proposal.risk === 'hard' && !(body.confirm === true)) {
                sendJson(res, 200, { ok: false, proposalId: proposal.proposalId, command: proposal.command, steps: [], exitCode: -1, signal: '', timedOut: false, stdout: '', stderr: '', diagnostics: '', error: '高风险操作：请先勾选“我已了解风险”再执行' })
                return
              }
              const agents = ctx.get('agents')
              const execAgent = agents ? agents.get(sessionId) : undefined
              const policy = sandboxPolicy ? sandboxPolicy.resolve({ session: execAgent && execAgent.session }) : undefined
              const result = await executeRegisteredProposal(shell, proposal, undefined, policy)
              console.log('git-guide HTTP execute', proposal.proposalId, 'ok=', result.ok)
              sendJson(res, 200, result)
              return
            }
            sendJson(res, 400, { ok: false, error: 'unknown action: ' + action })
          } catch (err) {
            sendJson(res, 500, { ok: false, error: redactAndLimit(String((err && err.message) || err), 2000) })
          }
        },
      })
    }
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (webCtx) => registerWebServer(webCtx.get('webServer')))
    } else {
      registerWebServer(ctx.get('webServer'))
    }
  },
}

// 供测试 / 二次开发复用的纯逻辑
module.exports.helpers = {
  parseCommand,
  validateCommand,
  classifyRisk,
  classifyStepsRisk,
  quoteShellArg,
  redactSecrets,
  redactAndLimit,
  addPathsOf,
  deriveChecks,
  runChecks,
  verifyProposal,
  captureFingerprint,
  captureDiagnostics,
  executeProposalSteps,
  executeRegisteredProposal,
  buildRecovery,
  registerRecoveryProposal,
  storeProposal,
  findProposal,
  proposalView,
  latestPending,
}
