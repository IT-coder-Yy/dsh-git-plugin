/**
 * dsh-easygit-plugin Host plugin package.
 *
 * It is mounted as one profile composition entry and serves every DeepSeek
 * Harness session. It uses only ctx.tools.register for tools and a
 * ctx.webServer POST /easygit route for Client-to-Host actions.
 *
 * The exposed model tools are git_propose and git_repo_state. Repository changes
 * are only available through the Client action route.
 */

import { registerEasyGitActions, type WebServerService, type ConnectionService } from './actions'
import type { GitFailureContext } from '../shared/contracts'
import {
  ProposalService,
  proposalService,
  type ProposalStorageUnit,
  type ProposalView,
  type StoredProposal,
} from './proposal-service'
import {
  GitRepositoryService,
  runShell,
  type GitRunResult,
  type ShellService,
} from './git-repository-service'
import {
  addPathsOf,
  classifyRisk,
  classifyStepsRisk,
  deriveChecks,
  modernizeCommand,
  parseCommand,
  quoteShellArg,
  redactAndLimit,
  redactSecrets,
  validateCommand,
  type ExpectedCheck,
} from './command-policy'

type UnknownRecord = Record<string, unknown>

interface SessionLike {
  cwd?: string
  header?: { cwd?: string }
}

interface AgentLike {
  id?: string
  session?: SessionLike
}

interface ToolExecutionContext {
  agent?: AgentLike
  signal?: AbortSignal
  concludeTurn?: () => void
}

interface ToolDefinition {
  name: string
  description: string
  parameters: UnknownRecord
  output: {
    schema: UnknownRecord
    render(args: UnknownRecord, value: unknown): Array<{ type: 'text'; text: string }>
  }
  execute(args: UnknownRecord, exec: ToolExecutionContext): Promise<UnknownRecord>
}

interface ToolsService {
  register(definition: ToolDefinition): unknown
}

interface AgentRegistryLike {
  get(sessionId: string): AgentLike | undefined
}

interface SessionRegistryLike {
  get(sessionId: string): SessionLike | undefined
}

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

interface SessionQueryLike {
  observeSession(sessionId: string): Promise<{
    header: { cwd?: string }
    projections?: { values: { sandboxMode?: SandboxMode | null } }
    [Symbol.dispose](): void
  }>
}

interface SandboxPolicyService {
  workspaceRoot?: string
  resolve(input: { session?: SessionLike; mode?: SandboxMode }): Record<string, unknown>
}

interface StorageBackendLike {
  kv?: { open(descriptor: UnknownRecord): Promise<ProposalStorageUnit> }
}

interface StorageServiceLike {
  backend: { get(name: string): StorageBackendLike }
}

interface HostContext {
  get<T = unknown>(name: string): T
  inject?(services: string[], callback: (context: HostContext) => unknown): unknown
  effect?(callback: () => () => void | Promise<void>): unknown
}

interface StepExecutionResult extends UnknownRecord {
  ok: boolean
  exitCode: number
  signal: string
  timedOut: boolean
  stdout: string
  stderr: string
}

interface ProposalExecutionResult extends UnknownRecord {
  ok: boolean
  proposalId: string
  command: string
  steps: Array<{ command: string; ok: boolean; exitCode: number }>
  exitCode: number
  signal: string
  timedOut: boolean
  stdout: string
  stderr: string
  diagnostics: string
  failure?: GitFailureContext
  recovery?: { suggestion: string; command: string; proposalId: string | null } | null
  analysis?: { proposalId: string }
  error: string
}

interface ProposalVerification {
  changed: boolean
  verified: boolean
  partial: boolean
  message: string
  changedState: string
}

interface RecoverySuggestion {
  suggestion: string
  command: string | null
  proposalId?: string
}

const MAX_STEPS = 10
function sessionIdOf(exec: ToolExecutionContext | undefined): string | null {
  try {
    const agent = exec && exec.agent
    if (agent && typeof agent.id === 'string' && agent.id.trim() && agent.id.trim().length <= 200) return agent.id.trim()
  } catch (e) { /* ignore */ }
  return null
}

function sessionWorkdir(exec: ToolExecutionContext | undefined, args: UnknownRecord | undefined, ctx: HostContext): string | undefined {
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
    const sp = ctx.get<SandboxPolicyService | null>('sandboxPolicy')
    if (sp && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot) return sp.workspaceRoot
  } catch (e) { /* ignore */ }
  return undefined
}

async function repositoryContextForSession(ctx: HostContext, sandboxPolicy: SandboxPolicyService | null, sessionId: string): Promise<{ workdir: string; policy: unknown } | null> {
  try {
    const agents = ctx.get<AgentRegistryLike | null>('agents')
    const agent = agents && agents.get(sessionId)
    const session = agent?.session ?? ctx.get<SessionRegistryLike | null>('sessions')?.get(sessionId)
    if (session) {
      const workdir = sessionWorkdir({ agent: { session } }, {}, ctx)
      if (!workdir) return null
      return { workdir, policy: sandboxPolicy?.resolve({ session }) }
    }
    // Cold sessions need no Agent turn: observe their persisted header and policy.
    const query = ctx.get<SessionQueryLike | null>('sessionQuery')
    if (!query) return null
    const observation = await query.observeSession(sessionId)
    try {
      const workdir = observation.header.cwd
      if (!workdir || !observation.projections) return null
      const mode = observation.projections.values.sandboxMode ?? undefined
      const policy = sandboxPolicy
        ? { ...sandboxPolicy.resolve({ mode }), workspaceRoot: workdir, sessionId }
        : undefined
      return { workdir, policy }
    } finally {
      observation[Symbol.dispose]()
    }
  } catch (error) {
    return null
  }
}

async function runGit(
  shell: ShellService,
  workdir: string | undefined,
  command: string,
  timeoutMs: number,
  stdoutMaxBytes: number,
  signal?: AbortSignal,
  policy?: unknown,
): Promise<GitRunResult> {
  try {
    const spec = shell.resolve({ command, workdir, timeoutMs, stdoutMaxBytes, signal, ...(policy ? { sandboxPolicy: policy } : {}) })
    return await runShell(shell, spec)
  } catch (err) {
    return { exitCode: -1, signal: null, timedOut: false, aborted: false, stdout: { text: '' }, stderr: { text: errorMessage(err) } }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function captureFingerprint(shell: ShellService | null | undefined, workdir: string): Promise<string | null> {
  if (!shell) return null
  const command = "echo '--B--'; git branch --show-current 2>&1; echo '--H--'; git rev-parse HEAD 2>&1; echo '--S--'; git status --short 2>&1; echo '--L--'; git log --oneline -3 2>&1; echo '--T--'; git stash list 2>&1"
  const r = await runGit(shell, workdir, command, 15000, 20000)
  return ((r.stdout?.text ?? '') + (r.stderr?.text ?? '')).trim()
}

async function captureDiagnostics(shell: ShellService | null | undefined, workdir: string): Promise<string> {
  if (!shell) return ''
  const command = "echo '--STATUS--'; git status --short --branch 2>&1; echo '--LOG--'; git log --oneline -3 2>&1; echo '--BRANCH--'; git branch -vv 2>&1; echo '--REMOTE--'; git remote -v 2>&1"
  const r = await runGit(shell, workdir, command, 15000, 20000)
  return redactAndLimit(((r.stdout?.text ?? '') + (r.stderr?.text ?? '')).trim())
}

async function runChecks(shell: ShellService | null | undefined, workdir: string, checks: readonly ExpectedCheck[]): Promise<string[]> {
  if (!shell) return checks.map((check) => check.label)
  const failed: string[] = []
  for (const c of checks) {
    let pass = false
    try {
      if (c.type === 'branch') {
        const r = await runGit(shell, workdir, 'git branch --show-current', 10000, 4096)
        pass = (r.stdout?.text ?? '').trim() === c.value
      } else if (c.type === 'commit-msg') {
        const r = await runGit(shell, workdir, 'git log -1 --pretty=%s', 10000, 4096)
        pass = (r.stdout?.text ?? '').trim() === c.value
      } else if (c.type === 'staged') {
        const paths = Array.isArray(c.value) ? c.value : String(c.value).split(/\s+/).filter(Boolean)
        pass = true
        for (const path of paths) {
          const r = await runGit(shell, workdir, 'git diff --cached --quiet -- ' + quoteShellArg(path), 10000, 4096)
          if (r.exitCode !== 1) { pass = false; break }
        }
      } else if (c.type === 'branch-gone') {
        const r = await runGit(shell, workdir, 'git branch --list ' + quoteShellArg(c.value), 10000, 4096)
        pass = (r.stdout?.text ?? '').trim() === ''
      } else if (c.type === 'stash-nonempty') {
        const r = await runGit(shell, workdir, 'git stash list', 10000, 4096)
        pass = (r.stdout?.text ?? '').trim().length > 0
      } else if (c.type === 'stash-empty') {
        const r = await runGit(shell, workdir, 'git stash list', 10000, 4096)
        pass = (r.stdout?.text ?? '').trim().length === 0
      } else if (c.type === 'clean') {
        const paths = Array.isArray(c.value) ? c.value : String(c.value).split(/\s+/).filter(Boolean)
        const r = await runGit(shell, workdir, 'git status --porcelain -- ' + paths.map(quoteShellArg).join(' '), 10000, 4096)
        pass = r.exitCode === 0 && (r.stdout?.text ?? '').trim() === ''
      } else if (c.type === 'no-ahead') {
        const r = await runGit(shell, workdir, 'git rev-list --count @{u}..HEAD 2>&1', 10000, 4096)
        pass = (r.stdout?.text ?? '').trim() === '0'
      }
    } catch (e) { pass = false }
    if (!pass) failed.push(c.label)
  }
  return failed
}

async function verifyProposal(shell: ShellService | null | undefined, proposal: StoredProposal): Promise<ProposalVerification> {
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

async function executeProposalSteps(shell: ShellService, proposal: StoredProposal, signal?: AbortSignal, policy?: unknown): Promise<{
  ok: boolean
  stepsResult: Array<{ command: string; ok: boolean; exitCode: number }>
}> {
  let ok = true
  const stepsResult: Array<{ command: string; ok: boolean; exitCode: number }> = []
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
    const result: StepExecutionResult = {
      ok: sok,
      exitCode: r.exitCode === null ? -1 : r.exitCode,
      signal: r.signal || '',
      timedOut: r.timedOut === true,
      stdout: redactAndLimit(r.stdout?.text ?? ''),
      stderr: redactAndLimit(r.stderr?.text ?? ''),
    }
    step.result = result
    stepsResult.push({ command: step.command, ok: sok, exitCode: result.exitCode })
    if (!sok) { ok = false; break }
  }
  proposal.result = { ok }
  return { ok, stepsResult }
}

function executionError(proposal: StoredProposal | null, error: string): ProposalExecutionResult {
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

async function executeRegisteredProposal(
  shell: ShellService | null | undefined,
  proposal: StoredProposal | null | undefined,
  signal?: AbortSignal,
  policy?: unknown,
  persistStatus?: () => Promise<void>,
): Promise<ProposalExecutionResult> {
  if (!proposal) return executionError(null, '找不到该提议（proposalId 无效或已过期）')
  if (proposal.closed === true || proposal.status === 'succeeded' || proposal.status === 'failed' || proposal.status === 'verified' || proposal.status === 'dismissed') {
    return executionError(proposal, '该提议已经结束，不能重复执行；如需重试，请创建新的提议')
  }
  if (proposal.status === 'running') return executionError(proposal, '该提议正在执行，请勿重复提交')
  if (!shell) return executionError(proposal, 'shell 服务不可用')

  proposal.status = 'running'
  proposal.startedAt = Date.now()
  if (typeof persistStatus === 'function') await persistStatus()
  const { ok, stepsResult } = await executeProposalSteps(shell, proposal, signal, policy)
  proposal.status = ok ? 'succeeded' : 'failed'
  proposal.finishedAt = Date.now()
  const last = proposal.steps[proposal.steps.length - 1]
  const failedStep = proposal.steps.find((step) => step.result?.ok === false)
  const lastResult = (failedStep ? failedStep.result : last?.result) as StepExecutionResult | null | undefined
  const diagnostics = ok ? '' : await captureDiagnostics(shell, proposal.workdir)
  const error = ok ? '' : redactSecrets((lastResult && (lastResult.stderr || lastResult.stdout)) || 'git 退出码 ' + (lastResult ? lastResult.exitCode : -1))
  const failure: GitFailureContext | undefined = ok ? undefined : {
    source: 'proposal',
    code: lastResult?.timedOut === true ? 'TIMEOUT' : 'GIT_FAILED',
    action: 'execute',
    command: failedStep?.command || proposal.command,
    message: error,
    stdout: redactSecrets(lastResult ? lastResult.stdout : ''),
    stderr: redactSecrets(lastResult ? lastResult.stderr : ''),
    diagnostics,
    exitCode: lastResult ? lastResult.exitCode : null,
    timedOut: lastResult?.timedOut === true,
    mayHavePartialChanges: proposal.steps.some((step) => step !== failedStep && step.result?.ok === true),
    occurredAt: Date.now(),
  }
  proposal.failure = failure
  const recovery = ok ? null : buildRecovery(proposal, failedStep, diagnostics)
  if (recovery && recovery.command && failure) {
    const corrected = registerRecoveryProposal(proposal, recovery, failure)
    if (corrected) recovery.proposalId = corrected.proposalId
  } else if (!ok && failure) {
    proposal.needsAgentAnalysis = true
  }
  if (typeof persistStatus === 'function') await persistStatus()
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
    ...(failure ? { failure } : {}),
    recovery: recovery ? { suggestion: recovery.suggestion, command: recovery.command || '', proposalId: recovery.proposalId || null } : null,
    ...(!ok && failure && !recovery?.command ? { analysis: { proposalId: proposal.proposalId } } : {}),
    error,
  }
}

/**
 * Derive a safe recovery command from a failed step and repository diagnostics.
 * A null command means the condition requires manual remediation.
 */
function buildRecovery(_proposal: StoredProposal, failedStep: StoredProposal['steps'][number] | undefined, diagnostics: string): RecoverySuggestion | null {
  if (!failedStep || !failedStep.result) return null
  const cmd = String(failedStep.command || '')
  const text = String(((failedStep.result.stderr || '') + ' ' + (failedStep.result.stdout || '') + ' ' + (diagnostics || '')).trim())
  return buildRecoveryForCommand(cmd, text)
}

function buildRecoveryForCommand(cmd: string, text: string, reason = ''): RecoverySuggestion | null {

  // 1. The execution environment is read-only; change the environment, not the command.
  if (/只读文件系统|read-only file system|EROFS|cannot lock ref|cannot create .*\.lock/i.test(text)) {
    return { suggestion: '执行环境对目标目录只读（沙箱策略或挂载问题）：请在终端手动执行该命令，或调整执行环境的沙箱权限。', command: null }
  }
  // 2. A .gitignore match can be addressed with git add -f for explicit paths.
  if (/(\.gitignore|被忽略|ignored by your|did not match any files|没有匹配任何文件)/i.test(text) && /git\s+add\b/.test(cmd)) {
    const corrected = cmd.replace(/git\s+add\s+/, 'git add -f ')
    if (corrected !== cmd) return { suggestion: '目标文件被 .gitignore 忽略：改用 -f 强制加入（仅针对明确列出的文件）。', command: corrected }
  }
  // 3. An existing target branch can be switched to instead of created.
  if (reason === 'BRANCH_EXISTS' || /already exist(?:s)?|分支.*已(?:经)?存在/i.test(text)) {
    const parsed = parseCommand(cmd)
    const createFlag = parsed.ok ? parsed.args.findIndex((argument) => argument === '-c' || argument === '-b') : -1
    const branch = parsed.ok && createFlag >= 2 ? parsed.args[createFlag + 1] : undefined
    if (branch) {
      const corrected = 'git switch ' + quoteShellArg(branch)
      return { suggestion: '分支 ' + branch + ' 已存在：改为切换到现有分支（或换一个分支名）。', command: corrected }
    }
  }
  // 4. The target directory is not a Git repository.
  if (/not a git repository|不是.*git 仓库|不是一个 git 仓库/i.test(text)) {
    return { suggestion: '目标目录不是 git 仓库：确认 workdir 指向仓库根目录，或先 git init。', command: null }
  }
  // 5. SSH or remote connectivity failed.
  if (/Bad owner or permissions|Could not resolve hostname|Permission denied \(publickey\)|ssh:|Connection (refused|timed out)/i.test(text)) {
    return { suggestion: 'SSH/远程连接失败：检查 ssh 配置与密钥（配置文件权限、密钥是否被授权），可临时用 git -c core.sshCommand 覆盖 ssh 参数。', command: null }
  }
  // 6. A push was rejected.
  if (/(rejected|failed to push|non-fast-forward|远程.*拒绝|推送.*失败)/i.test(text) && /git\s+push\b/.test(cmd)) {
    return { suggestion: '推送被拒绝：先 git pull --rebase 同步远程再重试；若确认要覆盖远程历史，需明确确认后使用 --force-with-lease（高风险）。', command: null }
  }
  // 7. There is no staged content to commit.
  if (/(nothing to commit|没有.*要提交|nothing added to commit)/i.test(text) && /git\s+commit\b/.test(cmd)) {
    return { suggestion: '没有可提交的改动：先 git add 暂存文件（注意被 .gitignore 忽略的文件需 -f）。', command: null }
  }
  // 8. The repository has merge conflicts.
  if (/CONFLICT|冲突|conflict/i.test(text)) {
    return { suggestion: '存在合并冲突：先解决冲突文件，再 git add 标记为已解决，最后 git commit 完成合并。', command: null }
  }
  // 9. The branch has no upstream tracking reference.
  if (/(No upstream|no upstream|没有上游|no tracking)/i.test(text)) {
    return { suggestion: '分支没有上游跟踪：用 git push -u origin <分支名> 建立跟踪后重试。', command: null }
  }
  return null
}

async function recoverFailedCommand(
  activeShell: ShellService | null | undefined,
  sessionId: string,
  workdir: string,
  operationId: string,
  action: string,
  command: string,
  message: string,
  errorOutput: string,
  errorCode: string,
  reason: string,
): Promise<{
  failure: GitFailureContext
  recovery?: { suggestion: string; command: string; proposalId: string | null }
  analysis?: { proposalId: string }
} | null> {
  const operationKey = workdir + '\u0000' + operationId
  const existing = proposalService.list(sessionId)?.find((proposal) => proposal.recoveryOperationKey === operationKey)
  if (existing) {
    if (!existing.failure) return null
    if (existing.needsAgentAnalysis === true) return { failure: existing.failure, analysis: { proposalId: existing.proposalId } }
    if (existing.closed || existing.status !== 'pending') return { failure: existing.failure }
    return { failure: existing.failure, recovery: {
      suggestion: String(existing.recoverySuggestion || existing.explanation),
      command: existing.command,
      proposalId: existing.proposalId,
    } }
  }
  const diagnostics = await captureDiagnostics(activeShell, workdir)
  const failure: GitFailureContext = {
    source: 'workbench',
    code: errorCode,
    action,
    command,
    message,
    stdout: '',
    stderr: redactSecrets(errorOutput),
    diagnostics,
    exitCode: null,
    timedOut: errorCode === 'TIMEOUT',
    mayHavePartialChanges: reason !== 'BRANCH_EXISTS',
    occurredAt: Date.now(),
  }
  const recovery = buildRecoveryForCommand(command, message + '\n' + errorOutput + '\n' + diagnostics, reason)
  if (!recovery?.command) {
    const failed = registerFailureProposal(sessionId, workdir, command, failure)
    if (failed) {
      failed.recoveryOperationKey = operationKey
      await proposalService.flush(sessionId)
    }
    return { failure, ...(failed ? { analysis: { proposalId: failed.proposalId } } : {}) }
  }
  const proposal = registerRecoveryProposal({ sessionId, workdir }, recovery, failure)
  if (!proposal) return { failure }
  proposal.recoveryOperationKey = operationKey
  proposal.recoverySuggestion = recovery.suggestion
  await proposalService.flush(sessionId)
  return { failure, recovery: { suggestion: recovery.suggestion, command: recovery.command, proposalId: proposal.proposalId } }
}

/** Register a recovery command as a pending proposal in the same session. */
function registerRecoveryProposal(
  failedProposal: Pick<StoredProposal, 'sessionId' | 'workdir'>,
  recovery: RecoverySuggestion,
  failure?: GitFailureContext,
): StoredProposal | null {
  if (!recovery.command) return null
  const v = validateCommand(recovery.command)
  if (!v.ok) return null
  const sessionId = failedProposal.sessionId
  const prev = proposalService.list(sessionId)
  if (prev && prev.some((p) => p.status === 'running')) return null
  const risk = classifyRisk(recovery.command)
  const proposal: StoredProposal = {
    proposalId: proposalService.newId(),
    sessionId,
    intent: '修正建议：' + recovery.suggestion,
    command: recovery.command.trim(),
    steps: [{ command: recovery.command.trim(), result: null }],
    explanation: failure
      ? '原命令：' + failure.command + '\n错误：' + (failure.stderr || failure.message) + '\n修正原因：' + recovery.suggestion
      : recovery.suggestion + '（由执行失败自动生成，请确认后执行）',
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
    recoverySuggestion: recovery.suggestion,
    ...(failure ? { failure } : {}),
  }
  proposalService.closeOpen(sessionId)
  storeProposal(sessionId, proposal)
  console.log('easygit 修正建议登记', proposal.proposalId, 'session=', sessionId, 'risk=', risk.level)
  return proposal
}

function registerFailureProposal(sessionId: string, workdir: string, command: string, failure: GitFailureContext): StoredProposal | null {
  if (proposalService.hasRunning(sessionId)) return null
  const risk = classifyRisk(command)
  const proposal: StoredProposal = {
    proposalId: proposalService.newId(),
    sessionId,
    intent: 'Git 操作失败，等待分析',
    command,
    steps: [{ command, result: { ok: false, stderr: failure.stderr, stdout: failure.stdout, exitCode: failure.exitCode } }],
    explanation: '原命令：' + command + '\n错误：' + (failure.stderr || failure.message),
    risk: risk.level,
    reasons: risk.reasons,
    confirmed: false,
    workdir,
    createdAt: failure.occurredAt,
    result: { ok: false, error: failure.message },
    closed: false,
    copied: false,
    fingerprint: null,
    verified: false,
    status: 'failed',
    failure,
    recovery: true,
    needsAgentAnalysis: true,
  }
  proposalService.closeOpen(sessionId)
  storeProposal(sessionId, proposal)
  console.log('easygit 失败上下文登记', proposal.proposalId, 'session=', sessionId)
  return proposal
}

function storeProposal(sessionId: string, proposal: StoredProposal): StoredProposal {
  return proposalService.store(sessionId, proposal)
}

function pruneProposalSessions(now = Date.now()): void {
  proposalService.prune(now)
}

function findProposal(sessionId: string, proposalId: unknown): StoredProposal | undefined {
  return proposalService.find(sessionId, proposalId)
}

function proposalView(proposal: StoredProposal): ProposalView {
  return proposalService.view(proposal)
}

function latestPending(sessionId: string): StoredProposal | null {
  return proposalService.latestPending(sessionId)
}

function connectProposalStorage(ctx: HostContext): Promise<void> {
  let storage: StorageServiceLike | null
  try { storage = ctx.get<StorageServiceLike | null>('storage') } catch (error) { storage = null }
  if (!storage || !storage.backend || typeof storage.backend.get !== 'function') return Promise.resolve()
  let unit: ProposalStorageUnit | undefined
  const ready = (async () => {
    const backend = storage.backend.get('json')
    if (!backend || !backend.kv || typeof backend.kv.open !== 'function') throw new Error('JSON storage backend does not support key-value units')
    unit = await backend.kv.open({
      name: 'easygit_proposals',
      version: 1,
      tables: ['proposals'],
      hasGlobal: false,
    })
    await proposalService.attachStorage(unit)
  })()
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => ready.then(() => unit ? proposalService.closeStorage(unit) : undefined))
  }
  return ready
}

const plugin = {
  name: 'easygit',
  inject: ['shell', 'tools'],
  apply(ctx: HostContext): void {
    const shell = ctx.get<ShellService | null>('shell')
    const tools = ctx.get<ToolsService | null>('tools')
    const sandboxPolicy = ctx.get<SandboxPolicyService | null>('sandboxPolicy')
    const repository = new GitRepositoryService(shell ?? undefined)
    const proposalStorageReady = connectProposalStorage(ctx)

    if (tools) {
      tools.register({
        name: 'git_propose',
        description: '当用户用自然语言描述一个想做的 git 操作（但不知道/不确定具体命令）时，调用本工具提出命令建议并登记为待处理提议。可先调用 git_repo_state 了解仓库现状，再选择最简洁、最安全、副作用最小的纯 git 命令并给出清晰中文解释。分支创建或切换必须优先使用 git switch，文件还原必须优先使用 git restore；除非没有现代等价命令，否则不要使用语义含混的 git checkout。多条命令请用 steps 数组分开传入（如 ["git add -A", "git commit -m \\"msg\\""]），不要用 && 拼成一条；插件会逐步执行、逐步校验、失败即停。登记成功后本轮 Agent 会结束，Git 工作台将展示提议；模型不得询问是否执行，也不能执行提议。高风险提议的明确风险确认由工作台中的用户操作完成。',
        parameters: {
          type: 'object',
          properties: {
            intent: { type: 'string', maxLength: 500, description: '用户想要完成的 git 操作意图（自然语言，简短描述）' },
            command: { type: 'string', maxLength: 800, description: '单条 git 命令（steps 为空时必填）。创建/切换分支使用 switch，还原文件使用 restore；只允许固定白名单内的纯 git 子命令，不允许全局选项、管道、重定向或 shell 展开' },
            steps: { type: 'array', maxItems: MAX_STEPS, items: { type: 'string', maxLength: 800 }, description: '多条 git 命令按执行顺序分开传入（推荐，代替 && 拼接）；优先使用 switch/restore 等职责明确的现代命令，每条单独校验、逐步执行、失败即停' },
            explanation: { type: 'string', maxLength: 4000, description: '为什么用这些命令：它们做什么、为什么最简洁安全、有什么副作用' },
            workdir: { type: 'string', maxLength: 4096, description: 'git 仓库目录（绝对路径）。省略时使用当前会话的工作目录' },
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
              workdir: { type: 'string' },
              error: { type: 'string' },
            },
            additionalProperties: false,
          },
          render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
        },
        async execute(args, exec) {
          await proposalStorageReady
          const sessionId = sessionIdOf(exec)
          if (!sessionId) {
            return { ok: false, proposalId: '', intent: String((args && args.intent) || ''), command: '', steps: [], explanation: String((args && args.explanation) || ''), risk: 'normal', reasons: [], workdir: '', error: '当前工具调用缺少会话身份，拒绝创建无法隔离的提议' }
          }
          args = args || {}
          if (String(args.intent || '').length > 500 || String(args.explanation || '').length > 4000 || String(args.workdir || '').length > 4096) {
            return { ok: false, proposalId: '', intent: '', command: '', steps: [], explanation: '', risk: 'normal', reasons: [], workdir: '', error: '输入过长：intent 最多 500 字符、explanation 最多 4000 字符、workdir 最多 4096 字符' }
          }
          const workdir = sessionWorkdir(exec, args, ctx)
          const rawCommands = Array.isArray(args.steps) && args.steps.length ? args.steps : (args.command ? [args.command] : [])
          if (rawCommands.length === 0) {
            return { ok: false, proposalId: '', intent: String(args.intent || ''), command: '', steps: [], explanation: String(args.explanation || ''), risk: 'normal', reasons: [], workdir: workdir || '', error: 'command 或 steps 至少提供一个' }
          }
          if (rawCommands.length > MAX_STEPS) {
            return { ok: false, proposalId: '', intent: String(args.intent || ''), command: '', steps: [], explanation: String(args.explanation || ''), risk: 'normal', reasons: [], workdir: workdir || '', error: '步骤过多（最多 ' + MAX_STEPS + ' 步）' }
          }
          const steps: StoredProposal['steps'] = []
          for (const raw of rawCommands) {
            const modern = modernizeCommand(raw)
            const v = validateCommand(modern.command)
            if (!v.ok) {
              return { ok: false, proposalId: '', intent: String(args.intent || ''), command: String(raw), steps: [], explanation: String(args.explanation || ''), risk: 'normal', reasons: [], workdir: workdir || '', error: '步骤「' + raw + '」校验失败：' + v.error }
            }
            if (v.subcommand === 'checkout') {
              return { ok: false, proposalId: '', intent: String(args.intent || ''), command: String(raw), steps: [], explanation: String(args.explanation || ''), risk: 'normal', reasons: [], workdir: workdir || '', error: '步骤「' + raw + '」仍使用语义含混的 git checkout；切换分支请改用 git switch，还原文件请改用 git restore' }
            }
            steps.push({ command: modern.command, result: null })
          }
          if (steps.length === 0) {
            return { ok: false, proposalId: '', intent: String(args.intent || ''), command: '', steps: [], explanation: String(args.explanation || ''), risk: 'normal', reasons: [], workdir: workdir || '', error: '没有可执行的命令步骤' }
          }
          if (shell) {
            const r = await runGit(shell, workdir, 'git rev-parse --show-toplevel', 15000, 4096, exec.signal)
            if (r.exitCode !== 0) {
              const errText = ((r.stderr?.text ?? '') + ' ' + (r.stdout?.text ?? '')).trim()
              return { ok: false, proposalId: '', intent: String(args.intent || ''), command: steps.map((s) => s.command).join(' && '), steps: steps.map((s) => ({ command: s.command })), explanation: String(args.explanation || ''), risk: 'normal', reasons: [], workdir: workdir || '', error: '目标目录不是 git 仓库（workdir=' + (workdir || '默认工作目录') + '）：' + errText.slice(0, 200) }
            }
          }
          const commandTexts = steps.map((s) => s.command)
          const risk = classifyStepsRisk(commandTexts)
          const prev = proposalService.list(sessionId)
          if (prev && prev.some((proposal) => proposal.status === 'running')) {
            return { ok: false, proposalId: '', intent: String(args.intent || ''), command: '', steps: [], explanation: String(args.explanation || ''), risk: risk.level, reasons: risk.reasons, workdir: workdir || '', error: '同一会话已有提议正在执行，请等待执行结束后再创建新提议' }
          }
          const analysisSource = prev?.find((candidate) => !candidate.closed
            && candidate.needsAgentAnalysis === true
            && typeof candidate.analysisRequestedAt === 'number'
            && !!candidate.failure)
          proposalService.closeOpen(sessionId)
          const proposal: StoredProposal = {
            proposalId: proposalService.newId(),
            sessionId,
            intent: String(args.intent || ''),
            command: commandTexts.join(' && '),
            steps,
            explanation: String(args.explanation || ''),
            risk: risk.level,
            reasons: risk.reasons,
            confirmed: false,
            workdir: workdir || '',
            createdAt: Date.now(),
            result: null,
            closed: false,
            copied: false,
            fingerprint: null,
            verified: false,
            status: 'pending',
            ...(analysisSource?.failure ? {
              failure: analysisSource.failure,
              recovery: true,
              recoverySuggestion: String(args.explanation || ''),
              analyzedFailureProposalId: analysisSource.proposalId,
            } : {}),
          }
          storeProposal(sessionId, proposal)
          await proposalService.flush(sessionId)
          if (typeof exec.concludeTurn === 'function') exec.concludeTurn()
          console.log('git_propose 登记', proposal.proposalId, 'session=', sessionId, 'risk=', risk.level, 'steps=', steps.length)
          return { ok: true, proposalId: proposal.proposalId, intent: proposal.intent, command: proposal.command, steps: steps.map((s) => ({ command: s.command })), explanation: proposal.explanation, risk: risk.level, reasons: risk.reasons, workdir: proposal.workdir, error: '' }
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
          const text = (r.stdout?.text ?? '') + (r.stderr?.text ?? '')
          const keys = ['__TOP__', '__BRANCH__', '__STATUS__', '__LOG__', '__STASH__', '__REMOTE__'] as const
          const parts: Record<string, string> = {}
          let idx = 0
          for (const [k, key] of keys.entries()) {
            const start = text.indexOf(key, idx)
            if (start < 0) { parts[key] = ''; continue }
            const valueStart = start + key.length
            const nextKey = keys[k + 1]
            const end = nextKey ? text.indexOf(nextKey, valueStart) : text.length
            parts[key] = end < 0 ? text.slice(valueStart) : text.slice(valueStart, end)
            idx = end < 0 ? text.length : end
          }
          const top = (parts.__TOP__ ?? '').trim()
          const isRepo = /^\/|^[A-Za-z]:[\\/]/.test(top)
          return {
            ok: true,
            isRepo,
            workdir: workdir || '',
            topLevel: top,
            branch: redactAndLimit((parts.__BRANCH__ ?? '').trim(), 4096),
            status: redactAndLimit((parts.__STATUS__ ?? '').trim()),
            recentCommits: redactAndLimit((parts.__LOG__ ?? '').trim()),
            stashes: redactAndLimit((parts.__STASH__ ?? '').trim()),
            remotes: redactAndLimit((parts.__REMOTE__ ?? '').trim()),
            error: '',
          }
        },
      })
    }

    const registerWebServer = (webServer: WebServerService | null, connection: ConnectionService | null): unknown => registerEasyGitActions(webServer, {
      repository,
      proposalStorageReady,
      shell,
      repositoryContext: (sessionId) => repositoryContextForSession(ctx, sandboxPolicy, sessionId),
      latestPending,
      findProposal,
      proposalView,
      flushProposal: (sessionId) => proposalService.flush(sessionId),
      captureFingerprint,
      runChecks,
      verifyProposal,
      executeProposal: (activeShell, proposal, policy, persist) => executeRegisteredProposal(activeShell, proposal, undefined, policy, persist),
      recoverFailedCommand: (sessionId, workdir, operationId, action, command, message, errorOutput, errorCode, reason) => recoverFailedCommand(
        shell, sessionId, workdir, operationId, action, command, message, errorOutput, errorCode, reason,
      ),
      resolveExecutionPolicy: async (sessionId) => {
        const context = await repositoryContextForSession(ctx, sandboxPolicy, sessionId)
        if (!context) throw new Error('无法确定当前会话的仓库目录')
        return context.policy
      },
    }, connection)
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer', 'connection'], (webCtx) => registerWebServer(webCtx.get<WebServerService | null>('webServer'), webCtx.get<ConnectionService | null>('connection')))
    } else {
      registerWebServer(ctx.get<WebServerService | null>('webServer'), ctx.get<ConnectionService | null>('connection'))
    }
  },
}

// Pure helpers exported for tests and downstream integrations.
const helpers = {
  parseCommand,
  validateCommand,
  modernizeCommand,
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
  buildRecoveryForCommand,
  recoverFailedCommand,
  registerRecoveryProposal,
  storeProposal,
  findProposal,
  proposalView,
  latestPending,
  ProposalService,
  GitRepositoryService,
}

export = Object.assign(plugin, { helpers })
