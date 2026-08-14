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

const PROPOSALS_PER_SESSION = 5
const proposalsBySession = new Map()
let proposalSeq = 0

function splitSegments(command) {
  const segments = []
  let current = ''
  let quote = null
  let outside = ''
  let i = 0
  const n = command.length
  while (i < n) {
    const ch = command[i]
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; i++; continue }
    if (ch === '\\') { current += ch + (command[i + 1] || ''); i += 2; continue }
    if (ch === '\n' || ch === ';') { segments.push(current); current = ''; i++; continue }
    if (ch === '&' && command[i + 1] === '&') { segments.push(current); current = ''; i += 2; continue }
    current += ch
    outside += ch
    i++
  }
  segments.push(current)
  return { segments: segments.map((s) => s.trim()).filter(Boolean), outside }
}

function validateCommand(command) {
  if (typeof command !== 'string' || command.trim().length === 0) return { ok: false, error: '命令为空' }
  if (command.length > 800) return { ok: false, error: '命令过长（最多 800 字符）' }
  if (/\$\(|\$\{|`/.test(command)) return { ok: false, error: '命令包含 shell 展开（$(...)、${...} 或反引号），只允许纯 git 命令' }
  const { segments, outside } = splitSegments(command)
  if (segments.length === 0) return { ok: false, error: '命令为空' }
  if (/[|<>]/.test(outside)) return { ok: false, error: '命令包含管道(|)或重定向(< >)，只允许纯 git 命令（多步请用 && 连接）' }
  for (const seg of segments) {
    if (!/^git(\s|$)/.test(seg)) return { ok: false, error: '命令段「' + seg + '」不是 git 命令；只允许以 git 开头的命令，多步用 && 连接' }
  }
  return { ok: true, segments }
}

function classifyRisk(command) {
  const reasons = []
  const HARD = [
    { re: /git\s+reset\s+--hard\b/, reason: 'git reset --hard 会丢弃工作区未提交的改动' },
    { re: /git\s+clean\s+-[^n]/, reason: 'git clean 会永久删除未跟踪的文件' },
    { re: /git\s+push\b[^\n]*?(-f|--force)\b/, reason: '强制推送会覆盖远程分支历史' },
    { re: /git\s+push\b[^\n]*?--delete\b/, reason: '删除远程分支' },
    { re: /git\s+rebase\b/, reason: 'rebase 会重写提交历史' },
    { re: /git\s+filter-branch\b/, reason: 'filter-branch 会大规模重写历史' },
    { re: /git\s+branch\s+(-D|--delete\s+--force)\b/, reason: '强制删除本地分支' },
    { re: /git\s+checkout\s+--(?=\s|$)/, reason: 'checkout -- 会用暂存区内容覆盖工作区文件' },
    { re: /git\s+checkout\s+\.\b/, reason: 'checkout . 会丢弃工作区全部改动' },
    { re: /git\s+rm\s+-f\b/, reason: 'git rm -f 会删除工作区文件' },
    { re: /git\s+stash\s+(drop|clear)\b/, reason: '会删除 stash 记录' },
  ]
  for (const rule of HARD) {
    if (rule.re.test(command)) reasons.push(rule.reason)
  }
  if (/git\s+restore\b/.test(command) && !/--staged\b/.test(command) && !/--source\b/.test(command) && !/\s-s\b/.test(command)) {
    reasons.push('git restore（无 --staged/--source）会丢弃工作区改动')
  }
  if (reasons.length > 0) return { level: 'hard', reasons }

  const SAFE_SUBS = new Set(['status','log','diff','show','branch','remote','fetch','tag','rev-parse','ls-files','ls-tree','grep','blame','shortlog','describe','reflog','show-ref','for-each-ref','count-objects','fsck','symbolic-ref','check-ignore','check-attr','verify-commit','verify-tag','cat-file','hash-object','merge-base','cherry','whatchanged'])
  const segs = splitSegments(command).segments
  let allSafe = segs.length > 0
  for (const seg of segs) {
    const m = seg.match(/^git\s+([^\s]+)/)
    const sub = m ? m[1] : ''
    let safe = SAFE_SUBS.has(sub)
    if (sub === 'branch' && /git\s+branch\s+(-d|-D|--delete)\b/.test(seg)) safe = false
    if (sub === 'remote' && /git\s+remote\s+(remove|rm)\b/.test(seg)) safe = false
    if (sub === 'tag' && /git\s+tag\s+(-d|--delete)\b/.test(seg)) safe = false
    if (!safe) { allSafe = false; break }
  }
  return allSafe ? { level: 'safe', reasons: [] } : { level: 'normal', reasons: [] }
}

function sessionIdOf(exec) {
  try {
    const agent = exec && exec.agent
    if (agent && typeof agent.id === 'string') return agent.id
  } catch (e) { /* ignore */ }
  return 'unknown'
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

async function runGit(shell, workdir, command, timeoutMs, stdoutMaxBytes, signal) {
  try {
    const spec = shell.resolve({ command, workdir, timeoutMs, stdoutMaxBytes, signal })
    return await shell.run(spec)
  } catch (err) {
    return { exitCode: -1, signal: null, timedOut: false, aborted: false, stdout: { text: '' }, stderr: { text: String((err && err.message) || err) } }
  }
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
  return ((r.stdout ? r.stdout.text : '') + (r.stderr ? r.stderr.text : '')).trim()
}

function addPathsOf(cmd) {
  const m = cmd.match(/git\s+add\s+(.+)/)
  if (!m) return null
  return m[1].trim().split(/\s+/).filter((t) => t !== '--' && !/^-(?!-)/.test(t)).join(' ')
}

function deriveChecks(commands) {
  const hasCommit = commands.some((c) => /git\s+commit\b/.test(c))
  const checks = []
  let lastBranch = null
  let lastCommitMsg = null
  let lastBranchGone = null
  let lastStaged = null
  let lastClean = null
  let stashOp = null
  let hasPush = false
  for (const cmd of commands) {
    let m = cmd.match(/git\s+(?:switch\s+-c|checkout\s+-b)\s+([^\s]+)/)
    if (m) lastBranch = m[1]
    m = cmd.match(/git\s+commit\b[^\n]*?-m\s+["']([^"']+)["']/)
    if (m) lastCommitMsg = m[1]
    m = cmd.match(/git\s+branch\s+(-D|-d)\s+([^\s]+)/)
    if (m) lastBranchGone = m[2]
    if (!hasCommit) {
      const p = addPathsOf(cmd)
      if (p) lastStaged = p
    }
    m = cmd.match(/git\s+(?:checkout\s+--|restore\s+(?!--staged\b)(?!--source\b))\s+(.+)/)
    if (m) lastClean = m[1].trim().split(/\s+/).filter((t) => !/^-(?!-)/.test(t)).join(' ')
    if (/git\s+stash\s+push/.test(cmd)) stashOp = 'nonempty'
    if (/git\s+stash\s+(drop|clear)/.test(cmd)) stashOp = 'empty'
    if (/git\s+push\b/.test(cmd)) hasPush = true
  }
  if (lastBranch) checks.push({ type: 'branch', value: lastBranch, label: '当前分支应为 ' + lastBranch })
  if (lastCommitMsg !== null) checks.push({ type: 'commit-msg', value: lastCommitMsg, label: '最近提交信息应为「' + lastCommitMsg + '」' })
  if (lastBranchGone) checks.push({ type: 'branch-gone', value: lastBranchGone, label: '分支 ' + lastBranchGone + ' 应已删除' })
  if (lastStaged) checks.push({ type: 'staged', value: lastStaged, label: '指定文件应已暂存' })
  if (lastClean) checks.push({ type: 'clean', value: lastClean, label: '指定文件的工作区改动应已丢弃' })
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
        const r = await runGit(shell, workdir, 'git diff --cached --name-only', 10000, 4096)
        const staged = new Set((r.stdout ? r.stdout.text : '').split('\n').map((s) => s.trim()).filter(Boolean))
        const paths = c.value.split(/\s+/).filter(Boolean)
        pass = paths.every((p) => staged.has(p))
      } else if (c.type === 'branch-gone') {
        const r = await runGit(shell, workdir, 'git branch --list ' + c.value, 10000, 4096)
        pass = (r.stdout ? r.stdout.text : '').trim() === ''
      } else if (c.type === 'stash-nonempty') {
        const r = await runGit(shell, workdir, 'git stash list', 10000, 4096)
        pass = (r.stdout ? r.stdout.text : '').trim().length > 0
      } else if (c.type === 'stash-empty') {
        const r = await runGit(shell, workdir, 'git stash list', 10000, 4096)
        pass = (r.stdout ? r.stdout.text : '').trim().length === 0
      } else if (c.type === 'clean') {
        const r = await runGit(shell, workdir, 'git status --porcelain', 10000, 4096)
        const paths = c.value.split(/\s+/).filter(Boolean)
        pass = paths.every((p) => !(r.stdout ? r.stdout.text : '').includes(p))
      } else if (c.type === 'no-ahead') {
        const r = await runGit(shell, workdir, 'git rev-list --count @{u}..HEAD 2>&1', 10000, 4096)
        pass = (r.stdout ? r.stdout.text : '').trim() === '0'
      }
    } catch (e) { pass = false }
    if (!pass) failed.push(c.label)
  }
  return failed
}

async function executeProposalSteps(shell, proposal) {
  let ok = true
  const stepsResult = []
  for (const step of proposal.steps) {
    const r = await runGit(shell, proposal.workdir, step.command, 120000, 500000)
    const sok = r.exitCode === 0
    step.result = {
      ok: sok,
      exitCode: r.exitCode === null ? -1 : r.exitCode,
      signal: r.signal || '',
      timedOut: r.timedOut,
      stdout: r.stdout ? r.stdout.text : '',
      stderr: r.stderr ? r.stderr.text : '',
    }
    stepsResult.push({ command: step.command, ok: sok, exitCode: step.result.exitCode })
    if (!sok) { ok = false; break }
  }
  proposal.result = { ok }
  return { ok, stepsResult }
}

function storeProposal(sessionId, p) {
  let list = proposalsBySession.get(sessionId)
  if (!list) { list = []; proposalsBySession.set(sessionId, list) }
  list.unshift(p)
  if (list.length > PROPOSALS_PER_SESSION) list.length = PROPOSALS_PER_SESSION
  return p
}

function findProposal(sessionId, proposalId, fallback) {
  if (!proposalId) return undefined
  const list = proposalsBySession.get(sessionId)
  if (list) {
    const p = list.find((x) => x.proposalId === proposalId)
    if (p) return p
  }
  if (!fallback) return undefined
  for (const entries of proposalsBySession.values()) {
    const p = entries.find((x) => x.proposalId === proposalId)
    if (p) return p
  }
  return undefined
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
  }
}

function latestPending(sessionId) {
  const list = proposalsBySession.get(sessionId)
  if (list) {
    for (const p of list) if (!(p.closed === true)) return p
  }
  return null
}

function latestPendingAnywhere() {
  let newest = null
  for (const entries of proposalsBySession.values()) {
    const p = entries.find((x) => !(x.closed === true))
    if (p && (!newest || p.createdAt > newest.createdAt)) newest = p
  }
  return newest
}

/** 读取 HTTP 请求体（上限 1MB），失败返回空串。 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 1024 * 1024) { req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

module.exports = {
  name: 'git-guide',
  inject: ['shell', 'tools'],
  apply(ctx) {
    const shell = ctx.get('shell')
    const tools = ctx.get('tools')

    if (tools) {
      tools.register({
        name: 'git_propose',
        description: '当用户用自然语言描述一个想做的 git 操作（但不知道/不确定具体命令）时，调用本工具提出命令建议并登记为可执行提议。用法：1)（可选）先调用 git_repo_state 了解仓库现状；2) 分析用户意图，选择最简洁、最安全、副作用最小的纯 git 命令；3) 给出清晰的中文解释。多条命令请用 steps 数组分开传入（如 ["git add -A", "git commit -m \\"msg\\""]），不要用 && 拼成一条 —— 插件会逐步执行、逐步校验、失败即停；单条命令用 command。工具会做安全校验并登记提议（新提议会自动顶替同会话旧的待处理提议），返回 proposalId。之后把命令和解释展示给用户，并让用户选择：直接执行 → 调用 git_execute(proposalId)；手动执行 → 让用户复制命令自行执行（面板会自动按预期结果校验）。若返回 needsConfirm: true，说明命令属于高风险（如 reset --hard、force push、rebase、clean -fd 等），必须向用户说明风险、获得明确同意后，再以 confirm: true 重新调用本工具登记。',
        parameters: {
          type: 'object',
          properties: {
            intent: { type: 'string', description: '用户想要完成的 git 操作意图（自然语言，简短描述）' },
            command: { type: 'string', description: '单条 git 命令（steps 为空时必填）。只允许纯 git 命令，不允许管道 |、重定向 < >、$(...)、反引号等 shell 特性' },
            steps: { type: 'array', items: { type: 'string' }, description: '多条 git 命令按执行顺序分开传入（推荐，代替 && 拼接）；每条单独校验、逐步执行、失败即停' },
            explanation: { type: 'string', description: '为什么用这些命令：它们做什么、为什么最简洁安全、有什么副作用' },
            workdir: { type: 'string', description: 'git 仓库目录（绝对路径）。省略时使用当前会话的工作目录' },
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
          const workdir = sessionWorkdir(exec, args, ctx)
          const rawCommands = args.steps && args.steps.length ? args.steps : (args.command ? [args.command] : [])
          if (rawCommands.length === 0) {
            return { ok: false, proposalId: '', intent: String(args.intent || ''), command: '', steps: [], explanation: String(args.explanation || ''), risk: 'normal', reasons: [], needsConfirm: false, workdir: workdir || '', error: 'command 或 steps 至少提供一个' }
          }
          const steps = []
          for (const raw of rawCommands) {
            const v = validateCommand(raw)
            if (!v.ok) {
              return { ok: false, proposalId: '', intent: String(args.intent || ''), command: String(raw), steps: [], explanation: String(args.explanation || ''), risk: 'normal', reasons: [], needsConfirm: false, workdir: workdir || '', error: '步骤「' + raw + '」校验失败：' + v.error }
            }
            for (const seg of v.segments) steps.push({ command: seg, result: null })
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
          let risk = { level: 'normal', reasons: [] }
          for (const c of commandTexts) {
            const rk = classifyRisk(c)
            if (rk.level === 'hard') {
              risk = { level: 'hard', reasons: [...new Set([...risk.reasons, ...rk.reasons])] }
            } else if (risk.level !== 'hard') {
              risk = { level: rk.level === 'safe' && risk.level === 'safe' ? 'safe' : 'normal', reasons: risk.reasons }
            }
          }
          const confirmed = args.confirm === true
          const prev = proposalsBySession.get(sessionId)
          if (prev) for (const pp of prev) { if (!(pp.closed === true)) pp.closed = true }
          const proposal = {
            proposalId: 'g' + (++proposalSeq).toString(36) + '-' + Date.now().toString(36),
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
          }
          storeProposal(sessionId, proposal)
          const needsConfirm = risk.level === 'hard' && !confirmed
          console.log('git_propose 登记', proposal.proposalId, 'session=', sessionId, 'risk=', risk.level, 'steps=', steps.length)
          return { ok: true, proposalId: proposal.proposalId, intent: proposal.intent, command: proposal.command, steps: steps.map((s) => ({ command: s.command })), explanation: proposal.explanation, risk: risk.level, reasons: risk.reasons, needsConfirm, workdir: proposal.workdir, error: '' }
        },
      })

      tools.register({
        name: 'git_execute',
        description: '执行一条已由 git_propose 登记并通过安全校验的提议（按 proposalId 执行，不接受任意命令）。按步骤顺序执行，任一步失败即停止，返回每步结果；失败时还会附带仓库诊断信息（状态/最近提交/分支跟踪/远程），供你判断原因。仅当用户明确选择“直接执行”时才调用。高风险（hard）命令执行时必须同时传 confirm: true，且只能在用户已明确同意后传。重要：若执行失败，不要只报告失败就结束 —— 请依据 error/stdout/stderr/diagnostics 分析失败原因（例如 ssh 配置错误、文件被 .gitignore 忽略、分支已存在、推送被拒绝、合并冲突等），然后调用 git_propose 提出一条能完成用户需求的修正后续命令（例如加 -f、改用 git -c 覆盖 ssh 参数、补上未执行的步骤、先解决冲突等），向用户确认后再执行。全部成功则该提议自动关闭（面板回到空闲）。执行后把结果汇报给用户。',
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
              error: { type: 'string' },
            },
            additionalProperties: false,
          },
          render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
        },
        async execute(args, exec) {
          const sessionId = sessionIdOf(exec)
          const proposal = findProposal(sessionId, args.proposalId, true)
          if (!proposal) return { ok: false, proposalId: String(args.proposalId || ''), command: '', steps: [], exitCode: -1, signal: '', timedOut: false, stdout: '', stderr: '', diagnostics: '', error: '找不到该提议（proposalId 无效或已过期）' }
          if (proposal.risk === 'hard' && args.confirm !== true) {
            return { ok: false, proposalId: proposal.proposalId, command: proposal.command, steps: [], exitCode: -1, signal: '', timedOut: false, stdout: '', stderr: '', diagnostics: '', error: '高风险命令需要用户明确同意后才能执行：请先向用户说明风险（' + proposal.reasons.join('；') + '），获得同意后以 confirm: true 重新调用' }
          }
          if (!shell) return { ok: false, proposalId: proposal.proposalId, command: proposal.command, steps: [], exitCode: -1, signal: '', timedOut: false, stdout: '', stderr: '', diagnostics: '', error: 'shell 服务不可用' }
          const { ok, stepsResult } = await executeProposalSteps(shell, proposal)
          if (ok) proposal.closed = true
          const last = proposal.steps[proposal.steps.length - 1]
          const failedStep = proposal.steps.find((s) => s.result && s.result.ok === false)
          const lastResult = failedStep ? failedStep.result : (last ? last.result : null)
          const diagnostics = ok ? '' : await captureDiagnostics(shell, proposal.workdir)
          console.log('git_execute 执行', proposal.proposalId, 'ok=', ok, 'steps=', stepsResult.length, ok ? '已关闭' : '保留')
          return {
            ok,
            proposalId: proposal.proposalId,
            command: proposal.command,
            steps: stepsResult,
            exitCode: lastResult ? lastResult.exitCode : -1,
            signal: lastResult ? lastResult.signal : '',
            timedOut: lastResult ? lastResult.timedOut : false,
            stdout: lastResult ? lastResult.stdout : '',
            stderr: lastResult ? lastResult.stderr : '',
            diagnostics,
            error: ok ? '' : ((failedStep && (failedStep.result.stderr || failedStep.result.stdout)) || 'git 退出码 ' + (lastResult ? lastResult.exitCode : -1)),
          }
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
            branch: parts['__BRANCH__'].trim(),
            status: parts['__STATUS__'].trim(),
            recentCommits: parts['__LOG__'].trim(),
            stashes: parts['__STASH__'].trim(),
            remotes: parts['__REMOTE__'].trim(),
            error: '',
          }
        },
      })
    }

    async function verifyProposal(p) {
      const now = await captureFingerprint(shell, p.workdir)
      const changed = now !== null && p.fingerprint !== null && now !== p.fingerprint
      const checks = deriveChecks(p.steps.map((s) => s.command))
      let verified = false
      let partial = false
      let message = ''
      if (checks.length > 0) {
        const failed = await runChecks(shell, p.workdir, checks)
        if (failed.length === 0) verified = true
        else if (changed) { partial = true; message = '检测到仓库状态变化，但预期结果未达成：' + failed.join('；') }
        else message = '未检测到预期结果：' + failed.join('；')
      } else if (changed) {
        verified = true
      } else {
        message = '未检测到仓库状态变化，看起来还没有执行'
      }
      return { changed, verified, partial, message, changedState: changed ? now : '' }
    }

    // Client→Host 通信：POST /git-guide，body.action 分发（body 上限 1MB）
    const webServer = ctx.get('webServer')
    if (webServer) {
      webServer.register({
        kind: 'prefix',
        path: '/git-guide',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          let body = {}
          try {
            const raw = await readBody(req)
            body = raw ? JSON.parse(raw) : {}
          } catch (e) {
            sendJson(res, 400, { ok: false, error: 'invalid json body' })
            return
          }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : 'unknown'
          const action = typeof body.action === 'string' ? body.action : ''
          try {
            if (action === 'state') {
              let p = latestPending(sessionId)
              if (!p) p = latestPending('unknown')
              if (!p) p = latestPendingAnywhere()
              const view = p ? proposalView(p) : null
              if (p && p.copied === true && p.fingerprint) {
                const v = await verifyProposal(p)
                sendJson(res, 200, { ok: true, proposal: view, changed: v.changed, verified: v.verified, partial: v.partial, message: v.message, changedState: v.changedState })
              } else {
                sendJson(res, 200, { ok: true, proposal: view, changed: false, verified: false, partial: false, message: '', changedState: '' })
              }
              return
            }
            if (action === 'dismiss') {
              const proposal = findProposal(sessionId, body.proposalId, true)
              if (!proposal) { sendJson(res, 200, { ok: false, error: '找不到该提议' }); return }
              proposal.closed = true
              proposal.manual = body.manual === true
              sendJson(res, 200, { ok: true })
              return
            }
            if (action === 'mark-copied') {
              const proposal = findProposal(sessionId, body.proposalId, true)
              if (!proposal) { sendJson(res, 200, { ok: false, error: '找不到该提议' }); return }
              proposal.copied = true
              proposal.fingerprint = await captureFingerprint(shell, proposal.workdir)
              sendJson(res, 200, { ok: true })
              return
            }
            if (action === 'verify') {
              const proposal = findProposal(sessionId, body.proposalId, true)
              if (!proposal) { sendJson(res, 200, { ok: false, error: '找不到该提议' }); return }
              if (proposal.copied !== true || !proposal.fingerprint) {
                sendJson(res, 200, { ok: true, changed: false, verified: false, partial: false, message: '尚未复制命令或缺少对比基线', changedState: '' })
                return
              }
              const v = await verifyProposal(proposal)
              if (v.verified) proposal.verified = true
              sendJson(res, 200, { ok: true, changed: v.changed, verified: v.verified, partial: v.partial, message: v.message, changedState: v.changedState })
              return
            }
            if (action === 'execute') {
              const proposal = findProposal(sessionId, body.proposalId, true)
              if (!proposal) { sendJson(res, 200, { ok: false, proposalId: body.proposalId || '', command: '', steps: [], exitCode: -1, signal: '', timedOut: false, stdout: '', stderr: '', diagnostics: '', error: '找不到该提议（proposalId 无效或已过期）' }); return }
              if (proposal.risk === 'hard' && !(body.confirm === true)) {
                sendJson(res, 200, { ok: false, proposalId: proposal.proposalId, command: proposal.command, steps: [], exitCode: -1, signal: '', timedOut: false, stdout: '', stderr: '', diagnostics: '', error: '高风险操作：请先勾选“我已了解风险”再执行' })
                return
              }
              if (!shell) { sendJson(res, 200, { ok: false, proposalId: proposal.proposalId, command: proposal.command, steps: [], exitCode: -1, signal: '', timedOut: false, stdout: '', stderr: '', diagnostics: '', error: 'shell 服务不可用' }); return }
              const { ok, stepsResult } = await executeProposalSteps(shell, proposal)
              const last = proposal.steps[proposal.steps.length - 1]
              const failedStep = proposal.steps.find((s) => s.result && s.result.ok === false)
              const lastResult = failedStep ? failedStep.result : (last ? last.result : null)
              const diagnostics = ok ? '' : await captureDiagnostics(shell, proposal.workdir)
              console.log('git-guide HTTP execute', proposal.proposalId, 'ok=', ok)
              sendJson(res, 200, {
                ok,
                proposalId: proposal.proposalId,
                command: proposal.command,
                steps: stepsResult,
                exitCode: lastResult ? lastResult.exitCode : -1,
                signal: lastResult ? lastResult.signal : '',
                timedOut: lastResult ? lastResult.timedOut : false,
                stdout: lastResult ? lastResult.stdout : '',
                stderr: lastResult ? lastResult.stderr : '',
                diagnostics,
                error: ok ? '' : ((failedStep && (failedStep.result.stderr || failedStep.result.stdout)) || 'git 退出码 ' + (lastResult ? lastResult.exitCode : -1)),
              })
              return
            }
            sendJson(res, 400, { ok: false, error: 'unknown action: ' + action })
          } catch (err) {
            sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
          }
        },
      })
    }
  },
}

// 供测试 / 二次开发复用的纯逻辑
module.exports.helpers = {
  splitSegments,
  validateCommand,
  classifyRisk,
  addPathsOf,
  deriveChecks,
  runChecks,
  captureFingerprint,
  captureDiagnostics,
  executeProposalSteps,
  storeProposal,
  findProposal,
  proposalView,
  latestPending,
  latestPendingAnywhere,
}
