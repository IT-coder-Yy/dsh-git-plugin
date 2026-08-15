export type RiskLevel = 'safe' | 'normal' | 'hard'

export interface ParsedCommand {
  ok: true
  args: string[]
  subcommand: string
  normalized: string
}

export interface InvalidCommand {
  ok: false
  error: string
}

export type ParseResult = ParsedCommand | InvalidCommand

export interface RiskAssessment {
  level: RiskLevel
  reasons: string[]
}

export interface ModernizedCommand {
  command: string
  changed: boolean
}

export interface ExpectedCheck {
  type: 'branch' | 'branch-gone' | 'commit-msg' | 'staged' | 'clean' | 'stash-nonempty' | 'stash-empty' | 'no-ahead'
  value: string | string[] | boolean
  label: string
}

export const MAX_COMMAND_LENGTH = 800

const allowedSubcommands = new Set([
  'add', 'blame', 'branch', 'cat-file', 'check-attr', 'check-ignore', 'checkout',
  'cherry', 'cherry-pick', 'clean', 'commit', 'count-objects', 'describe', 'diff',
  'fetch', 'for-each-ref', 'fsck', 'grep', 'hash-object', 'log', 'ls-files',
  'ls-tree', 'merge', 'merge-base', 'mv', 'pull', 'push', 'rebase', 'reflog',
  'remote', 'reset', 'restore', 'revert', 'rev-parse', 'rm', 'shortlog', 'show',
  'show-ref', 'stash', 'status', 'switch', 'tag', 'verify-commit',
  'verify-tag', 'whatchanged',
])

const safeSubcommands = new Set([
  'blame', 'check-attr', 'check-ignore', 'cherry', 'count-objects', 'describe',
  'diff', 'for-each-ref', 'grep', 'log', 'ls-files', 'ls-tree', 'merge-base',
  'rev-parse', 'shortlog', 'show', 'show-ref', 'status', 'verify-commit',
  'verify-tag', 'whatchanged',
])

export function quoteShellArg(value: unknown): string {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

export function parseCommand(command: unknown): ParseResult {
  if (typeof command !== 'string' || command.trim().length === 0) return { ok: false, error: '命令为空' }
  if (command.length > MAX_COMMAND_LENGTH) return { ok: false, error: '命令过长（最多 800 字符）' }
  if (/\0|\r|\n/.test(command)) return { ok: false, error: '每个步骤只能包含一条命令，多步操作请使用 steps 数组' }

  const args: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let started = false
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? ''
    if (quote === "'") {
      if (character === "'") quote = null
      else current += character
      started = true
      continue
    }
    if (quote === '"') {
      if (character === '"') { quote = null; continue }
      if (character === '$' || character === '`') return { ok: false, error: '双引号内不允许 shell 展开（$ 或反引号）' }
      if (character === '\\') {
        if (index + 1 >= command.length) return { ok: false, error: '命令末尾存在不完整的转义' }
        const next = command[index += 1] ?? ''
        current += ['"', '\\', '$', '`'].includes(next) ? next : '\\' + next
      } else current += character
      started = true
      continue
    }
    if (/\s/.test(character)) {
      if (started) { args.push(current); current = ''; started = false }
      continue
    }
    if (character === "'" || character === '"') { quote = character; started = true; continue }
    if (character === '\\') {
      if (index + 1 >= command.length) return { ok: false, error: '命令末尾存在不完整的转义' }
      current += command[index += 1] ?? ''
      started = true
      continue
    }
    if (';&|<>'.includes(character)) return { ok: false, error: '命令包含 shell 控制符（; & | < >），多步操作请使用 steps 数组' }
    if (character === '$' || character === '`') return { ok: false, error: '命令包含 shell 展开（$ 或反引号）' }
    current += character
    started = true
  }
  if (quote) return { ok: false, error: '命令包含未闭合的引号' }
  if (started) args.push(current)
  if (args.length < 2 || args[0] !== 'git') return { ok: false, error: '只允许“git <子命令> ...”格式' }
  if (args.length > 80) return { ok: false, error: '命令参数过多（最多 80 个）' }

  const subcommand = args[1]!
  if (subcommand.startsWith('-')) return { ok: false, error: '不允许 git 全局选项（如 -c、-C、--exec-path）；请通过 workdir 指定仓库' }
  if (!allowedSubcommands.has(subcommand)) {
    return { ok: false, error: '不支持 git 子命令「' + subcommand + '」；该限制用于阻止 alias、外部 git-* 程序和可执行脚本入口' }
  }

  const forbiddenOptions = ['--ext-diff', '--textconv', '--open-files-in-pager', '--upload-pack', '--receive-pack']
  for (const argument of args.slice(2)) {
    if (forbiddenOptions.some((option) => argument === option || argument.startsWith(option + '='))) {
      return { ok: false, error: '不允许可能启动外部程序的选项「' + argument + '」' }
    }
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(argument)) {
      return { ok: false, error: '远程 URL 不得内嵌用户名、令牌或密码，请使用凭据管理器' }
    }
    if (/^ext::/i.test(argument)) return { ok: false, error: '不允许 ext:: 远程助手执行外部命令' }
    if (/AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}/.test(argument)) {
      return { ok: false, error: '命令疑似包含访问密钥或令牌，已拒绝登记' }
    }
  }
  const tail = args.slice(2)
  if (['merge', 'pull', 'rebase', 'cherry-pick', 'revert'].includes(subcommand) && tail.some((argument) => /^-s(?:.+)?$/.test(argument) || argument.startsWith('--strategy=') || argument === '--strategy')) {
    return { ok: false, error: '不允许选择自定义 merge strategy，以免启动外部 git-merge-* 程序' }
  }
  if (subcommand === 'push' && tail.some((argument) => argument === '--exec' || argument.startsWith('--exec='))) {
    return { ok: false, error: '不允许 git push --exec 指定远端接收程序' }
  }
  if (subcommand === 'grep' && tail.some((argument) => argument === '-O' || argument.startsWith('-O'))) {
    return { ok: false, error: '不允许 git grep -O 启动 pager 程序' }
  }
  if (subcommand === 'cat-file' && tail.some((argument) => argument === '--filters' || argument.startsWith('--filters='))) {
    return { ok: false, error: '不允许 git cat-file --filters 启动内容过滤程序' }
  }
  if (subcommand === 'rebase' && tail.some((argument) => argument === '-x' || argument.startsWith('-x') || argument === '--exec' || argument.startsWith('--exec='))) {
    return { ok: false, error: '不允许 git rebase --exec/-x 执行任意 shell 命令' }
  }

  return { ok: true, args, subcommand, normalized: args.map(quoteShellArg).join(' ') }
}

export function validateCommand(command: unknown): ParseResult & { segments?: string[] } {
  const parsed = parseCommand(command)
  return parsed.ok ? { ...parsed, segments: [String(command).trim()] } : parsed
}

function displayCommand(args: readonly string[]): string {
  return args.map((argument) => /^[A-Za-z0-9_@%+=:,./~-]+$/.test(argument) && !argument.startsWith('~') ? argument : quoteShellArg(argument)).join(' ')
}

export function modernizeCommand(command: unknown): ModernizedCommand {
  const original = typeof command === 'string' ? command.trim() : String(command ?? '')
  const parsed = parseCommand(command)
  if (!parsed.ok || parsed.subcommand !== 'checkout') return { command: original, changed: false }
  const tail = parsed.args.slice(2)
  if ((tail[0] === '-b' || tail[0] === '-B') && (tail.length === 2 || tail.length === 3)) {
    return {
      command: displayCommand(['git', 'switch', tail[0] === '-b' ? '-c' : '-C', ...tail.slice(1)]),
      changed: true,
    }
  }
  if (tail[0] === '--' && tail.length > 1) {
    return { command: displayCommand(['git', 'restore', ...tail]), changed: true }
  }
  if (tail.length > 2 && tail[1] === '--' && !tail[0]!.startsWith('-')) {
    return {
      command: displayCommand(['git', 'restore', '--source=' + tail[0], ...tail.slice(1)]),
      changed: true,
    }
  }
  return { command: original, changed: false }
}

export function classifyRisk(command: unknown): RiskAssessment {
  const parsed = parseCommand(command)
  if (!parsed.ok) return { level: 'hard', reasons: ['命令无法通过安全解析：' + parsed.error] }
  const { args, subcommand } = parsed
  const tail = args.slice(2)
  const reasons: string[] = []
  const hasLong = (name: string) => tail.some((argument) => argument === name || argument.startsWith(name + '='))
  const hasShort = (letter: string) => tail.some((argument) => /^-[^-]/.test(argument) && argument.slice(1).includes(letter))
  if (subcommand === 'reset') reasons.push(hasLong('--hard') ? 'git reset --hard 会丢弃工作区未提交的改动' : 'git reset 可能移动分支历史或重置索引')
  if (subcommand === 'clean' && !hasShort('n') && !hasLong('--dry-run')) reasons.push('git clean 会永久删除未跟踪的文件')
  if (subcommand === 'push') {
    if (hasShort('f') || hasLong('--force') || hasLong('--force-with-lease') || hasLong('--force-if-includes') || tail.some((argument) => argument.startsWith('+'))) reasons.push('强制推送会覆盖远程分支历史')
    if (hasShort('d') || hasLong('--delete') || hasLong('--mirror') || hasLong('--prune') || tail.some((argument) => argument.startsWith(':'))) reasons.push('该 push 可能删除远程引用')
  }
  if (subcommand === 'rebase') reasons.push('rebase 会重写提交历史')
  if (subcommand === 'pull' && hasLong('--rebase')) reasons.push('pull --rebase 会重写本地提交历史')
  if (subcommand === 'branch' && (hasShort('d') || hasShort('D') || hasShort('f') || hasShort('M') || hasLong('--delete') || hasLong('--force'))) reasons.push('移动、覆盖或删除本地分支可能丢失提交引用')
  if (subcommand === 'checkout') reasons.push('checkout 可能切换分支、移动分支引用或覆盖工作区文件；建议优先使用 switch/restore')
  if (subcommand === 'switch' && (hasShort('f') || hasShort('C') || hasLong('--force') || hasLong('--force-create') || hasLong('--discard-changes'))) reasons.push('switch 会丢弃工作区改动或强制移动分支')
  if (subcommand === 'restore' && (!hasLong('--staged') || hasLong('--worktree'))) reasons.push('git restore 会丢弃工作区改动')
  if (subcommand === 'rm') reasons.push('git rm 会删除工作区文件并暂存删除操作')
  if (subcommand === 'stash' && (tail[0] === 'drop' || tail[0] === 'clear')) reasons.push('会删除 stash 记录')
  if (subcommand === 'commit' && hasLong('--amend')) reasons.push('commit --amend 会重写最近一次提交')
  if (subcommand === 'reflog' && (tail[0] === 'delete' || tail[0] === 'expire')) reasons.push('会删除或过期 reflog 恢复记录')
  if (subcommand === 'tag' && (hasShort('d') || hasLong('--delete'))) reasons.push('删除 tag 会移除提交标签')
  if (subcommand === 'tag' && (hasShort('f') || hasLong('--force'))) reasons.push('强制更新 tag 会移动已有标签')
  return reasons.length > 0 ? { level: 'hard', reasons } : safeSubcommands.has(subcommand) ? { level: 'safe', reasons: [] } : { level: 'normal', reasons: [] }
}

export function classifyStepsRisk(commands: readonly string[]): RiskAssessment {
  let level: RiskLevel = 'safe'
  const reasons: string[] = []
  for (const command of commands) {
    const risk = classifyRisk(command)
    if (risk.level === 'hard') level = 'hard'
    else if (risk.level === 'normal' && level === 'safe') level = 'normal'
    for (const reason of risk.reasons) if (!reasons.includes(reason)) reasons.push(reason)
  }
  return { level, reasons }
}

export function redactSecrets(value: unknown): string {
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

export function redactAndLimit(value: unknown, maxChars = 20000): string {
  const redacted = redactSecrets(value)
  return redacted.length <= maxChars ? redacted : redacted.slice(0, maxChars) + '\n…[输出已截断]'
}

export function addPathsOf(command: string): string | null {
  const parsed = parseCommand(command)
  if (!parsed.ok || parsed.subcommand !== 'add') return null
  const tail = parsed.args.slice(2)
  if (tail.some((argument) => ['-A', '--all', '-u', '--update', '--refresh', '--renormalize', '--pathspec-from-file'].some((option) => argument === option || argument.startsWith(option + '=')))) return ''
  const separator = tail.indexOf('--')
  const paths = separator >= 0 ? tail.slice(separator + 1) : tail.filter((argument) => !argument.startsWith('-'))
  return paths.join(' ')
}

export function deriveChecks(commands: readonly string[]): ExpectedCheck[] {
  const parsedCommands = commands.map(parseCommand).filter((parsed): parsed is ParsedCommand => parsed.ok)
  const hasCommit = parsedCommands.some((parsed) => parsed.subcommand === 'commit')
  const checks: ExpectedCheck[] = []
  let lastBranch: string | null = null
  let lastCommitMessage: string | null = null
  const branchesGone: string[] = []
  let lastStaged: string[] = []
  let lastClean: string[] = []
  let stashOperation: 'nonempty' | 'empty' | null = null
  let hasPush = false
  for (const parsed of parsedCommands) {
    const tail = parsed.args.slice(2)
    if (parsed.subcommand === 'switch' || parsed.subcommand === 'checkout') {
      const createOptions = parsed.subcommand === 'switch' ? ['-c', '-C', '--create', '--force-create'] : ['-b', '-B']
      for (let index = 0; index < tail.length - 1; index += 1) if (createOptions.includes(tail[index]!)) lastBranch = tail[index + 1]!
    }
    if (parsed.subcommand === 'commit') {
      for (let index = 0; index < tail.length; index += 1) {
        const argument = tail[index]!
        if ((argument === '-m' || argument === '--message') && index + 1 < tail.length) { lastCommitMessage = tail[index + 1]!; break }
        if (argument.startsWith('--message=')) { lastCommitMessage = argument.slice('--message='.length); break }
      }
    }
    if (parsed.subcommand === 'branch') {
      const deleteAt = tail.findIndex((argument) => argument === '-d' || argument === '-D' || argument === '--delete')
      if (deleteAt >= 0) branchesGone.push(...tail.slice(deleteAt + 1).filter((argument) => !argument.startsWith('-')))
    }
    if (!hasCommit && parsed.subcommand === 'add') {
      const paths = addPathsOf(parsed.args.map(quoteShellArg).join(' '))
      const separator = tail.indexOf('--')
      if (paths) lastStaged = separator >= 0 ? tail.slice(separator + 1) : tail.filter((argument) => !argument.startsWith('-'))
    }
    if (parsed.subcommand === 'checkout' || parsed.subcommand === 'restore') {
      const separator = tail.indexOf('--')
      if (separator >= 0) lastClean = tail.slice(separator + 1)
      else if (parsed.subcommand === 'restore' && !tail.some((argument) => argument === '--staged' || argument.startsWith('--staged='))) lastClean = tail.filter((argument) => !argument.startsWith('-'))
    }
    if (parsed.subcommand === 'stash' && (tail[0] === 'push' || tail.length === 0)) stashOperation = 'nonempty'
    if (parsed.subcommand === 'stash' && (tail[0] === 'drop' || tail[0] === 'clear')) stashOperation = 'empty'
    if (parsed.subcommand === 'push') hasPush = true
  }
  if (lastBranch) checks.push({ type: 'branch', value: lastBranch, label: '当前分支应为 ' + lastBranch })
  if (lastCommitMessage !== null) checks.push({ type: 'commit-msg', value: lastCommitMessage, label: '最近提交信息应为「' + lastCommitMessage + '」' })
  for (const branch of branchesGone) checks.push({ type: 'branch-gone', value: branch, label: '分支 ' + branch + ' 应已删除' })
  if (lastStaged.length) checks.push({ type: 'staged', value: lastStaged, label: '指定文件应已暂存' })
  if (lastClean.length) checks.push({ type: 'clean', value: lastClean, label: '指定文件的工作区改动应已丢弃' })
  if (stashOperation === 'nonempty') checks.push({ type: 'stash-nonempty', value: true, label: 'stash 应非空' })
  if (stashOperation === 'empty') checks.push({ type: 'stash-empty', value: true, label: 'stash 应为空' })
  if (hasPush) checks.push({ type: 'no-ahead', value: true, label: '应已推送（不再领先远程）' })
  return checks
}
