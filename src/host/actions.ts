import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GitGuideAction, ProposalView } from '../shared/contracts'
import { deriveChecks, redactAndLimit } from './command-policy'
import type { GitRepositoryService, ShellService } from './git-repository-service'
import type { StoredProposal } from './proposal-service'

type UnknownRecord = Record<string, unknown>

export interface WebServerService {
  register(definition: {
    kind: 'prefix'
    path: string
    handler(req: IncomingMessage, res: ServerResponse): Promise<void>
  }): unknown
}

interface ProposalVerification {
  changed: boolean
  verified: boolean
  partial: boolean
  message: string
  changedState: string
}

interface GitGuideActionDependencies {
  repository: GitRepositoryService
  proposalStorageReady: Promise<void>
  shell: ShellService | null
  repositoryContext(sessionId: string): { workdir: string; policy: unknown } | null
  latestPending(sessionId: string): StoredProposal | null
  findProposal(sessionId: string, proposalId: unknown): StoredProposal | undefined
  proposalView(proposal: StoredProposal): ProposalView
  flushProposal(sessionId: string): Promise<void>
  captureFingerprint(shell: ShellService | null, workdir: string): Promise<string | null>
  runChecks(shell: ShellService | null, workdir: string, checks: ReturnType<typeof deriveChecks>): Promise<string[]>
  verifyProposal(shell: ShellService | null, proposal: StoredProposal): Promise<ProposalVerification>
  executeProposal(shell: ShellService | null, proposal: StoredProposal, policy: unknown, persist: () => Promise<void>): Promise<UnknownRecord>
  resolveExecutionPolicy(sessionId: string): unknown
}

const REPOSITORY_ACTIONS = [
  'get-summary',
  'get-diff',
  'get-branches',
  'get-commits',
  'get-commit-detail',
  'get-commit-diff',
  'get-stashes',
  'stage-paths',
  'unstage-paths',
  'stage-all',
  'unstage-all',
  'commit',
  'create-branch',
  'switch-branch',
  'delete-branch',
] as const satisfies readonly GitGuideAction[]

function isRepositoryAction(action: string): action is typeof REPOSITORY_ACTIONS[number] {
  return (REPOSITORY_ACTIONS as readonly string[]).includes(action)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer | string) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += part.length
      if (size > 1024 * 1024) { chunks.length = 0; finish(null); return }
      if (!settled) chunks.push(part)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(''))
  })
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(data))
}

async function dispatchRepositoryAction(
  action: typeof REPOSITORY_ACTIONS[number],
  sessionId: string,
  body: UnknownRecord,
  dependencies: GitGuideActionDependencies,
): Promise<unknown> {
  const context = dependencies.repositoryContext(sessionId)
  if (!context) return { ok: false, code: 'SESSION_NOT_FOUND', message: '无法确定当前会话的仓库目录' }
  const repository = dependencies.repository
  const base = { sessionId, workdir: context.workdir, operationId: body.operationId, sandboxPolicy: context.policy }
  if (action === 'get-summary') return repository.getSummary(context.workdir, undefined, context.policy)
  if (action === 'get-diff') return repository.getDiff(context.workdir, body.path, body.staged === true, undefined, context.policy)
  if (action === 'get-branches') return repository.getBranches(context.workdir, undefined, context.policy)
  if (action === 'get-commits') return repository.getCommits(context.workdir, body.limit, undefined, context.policy)
  if (action === 'get-commit-detail') return repository.getCommitDetail(context.workdir, body.hash, undefined, context.policy)
  if (action === 'get-commit-diff') return repository.getCommitDiff(context.workdir, body.hash, undefined, context.policy)
  if (action === 'get-stashes') return repository.getStashes(context.workdir, undefined, context.policy)
  if (action === 'stage-paths') return repository.stagePaths(base, body.paths)
  if (action === 'unstage-paths') return repository.unstagePaths(base, body.paths)
  if (action === 'stage-all') return repository.stageAll(base)
  if (action === 'unstage-all') return repository.unstageAll(base)
  if (action === 'commit') return repository.commit(base, body.message)
  if (action === 'create-branch') return repository.createBranch(base, body.name, body.base)
  if (action === 'switch-branch') return repository.switchBranch(base, body.name)
  return repository.deleteBranch(base, body.name, body.force === true, body.confirmRisk === true)
}

async function dispatchProposalAction(
  action: string,
  sessionId: string,
  body: UnknownRecord,
  dependencies: GitGuideActionDependencies,
): Promise<{ status: number; data: unknown }> {
  if (action === 'state') {
    const proposal = dependencies.latestPending(sessionId)
    if (proposal && proposal.status === 'pending' && proposal.copied === true && proposal.fingerprint) {
      const verification = await dependencies.verifyProposal(dependencies.shell, proposal)
      if (verification.verified) {
        proposal.verified = true
        proposal.status = 'verified'
        await dependencies.flushProposal(sessionId)
      }
      return { status: 200, data: { ok: true, proposal: dependencies.proposalView(proposal), ...verification } }
    }
    return { status: 200, data: { ok: true, proposal: proposal ? dependencies.proposalView(proposal) : null, changed: false, verified: false, partial: false, message: '', changedState: '' } }
  }

  if (action === 'dismiss') {
    const proposal = dependencies.findProposal(sessionId, body.proposalId)
    if (!proposal) return { status: 200, data: { ok: false, error: '找不到该提议' } }
    if (proposal.status === 'running') return { status: 200, data: { ok: false, error: '该提议正在执行，不能放弃' } }
    proposal.closed = true
    proposal.status = 'dismissed'
    proposal.manual = body.manual === true
    await dependencies.flushProposal(sessionId)
    return { status: 200, data: { ok: true } }
  }

  if (action === 'mark-copied') {
    const proposal = dependencies.findProposal(sessionId, body.proposalId)
    if (!proposal) return { status: 200, data: { ok: false, error: '找不到该提议' } }
    if (proposal.status !== 'pending') return { status: 200, data: { ok: false, error: '该提议已不再等待执行' } }
    if (proposal.risk === 'hard' && body.confirm !== true) return { status: 200, data: { ok: false, error: '高风险操作：请先勾选“我已了解风险”再复制' } }
    proposal.fingerprint = await dependencies.captureFingerprint(dependencies.shell, proposal.workdir)
    proposal.baselineFailed = await dependencies.runChecks(dependencies.shell, proposal.workdir, deriveChecks(proposal.steps.map((step) => step.command)))
    proposal.copied = true
    await dependencies.flushProposal(sessionId)
    return { status: 200, data: { ok: true } }
  }

  if (action === 'verify') {
    const proposal = dependencies.findProposal(sessionId, body.proposalId)
    if (!proposal) return { status: 200, data: { ok: false, error: '找不到该提议' } }
    if (proposal.status !== 'pending') return { status: 200, data: { ok: false, changed: false, verified: false, partial: false, message: '该提议已不再等待手动验证', changedState: '' } }
    if (proposal.copied !== true || !proposal.fingerprint) {
      return { status: 200, data: { ok: true, changed: false, verified: false, partial: false, message: '尚未复制命令或缺少对比基线', changedState: '' } }
    }
    const verification = await dependencies.verifyProposal(dependencies.shell, proposal)
    if (verification.verified) {
      proposal.verified = true
      proposal.status = 'verified'
    }
    await dependencies.flushProposal(sessionId)
    return { status: 200, data: { ok: true, ...verification } }
  }

  if (action === 'execute') {
    const proposal = dependencies.findProposal(sessionId, body.proposalId)
    if (!proposal) {
      return { status: 200, data: { ok: false, proposalId: body.proposalId || '', command: '', steps: [], exitCode: -1, signal: '', timedOut: false, stdout: '', stderr: '', diagnostics: '', error: '找不到该提议（proposalId 无效或已过期）' } }
    }
    if (proposal.risk === 'hard' && body.confirm !== true) {
      return { status: 200, data: { ok: false, proposalId: proposal.proposalId, command: proposal.command, steps: [], exitCode: -1, signal: '', timedOut: false, stdout: '', stderr: '', diagnostics: '', error: '高风险操作：请先勾选“我已了解风险”再执行' } }
    }
    const result = await dependencies.executeProposal(
      dependencies.shell,
      proposal,
      dependencies.resolveExecutionPolicy(sessionId),
      () => dependencies.flushProposal(sessionId),
    )
    console.log('git-guide HTTP execute', proposal.proposalId, 'ok=', result.ok)
    return { status: 200, data: result }
  }

  return { status: 400, data: { ok: false, error: 'unknown action: ' + action } }
}

/** Register the Client-to-Host POST dispatcher with a 1 MiB body limit. */
export function registerGitGuideActions(webServer: WebServerService | null, dependencies: GitGuideActionDependencies): unknown {
  if (!webServer) return undefined
  return webServer.register({
    kind: 'prefix',
    path: '/git-guide',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      if (req.headers?.['sec-fetch-site'] === 'cross-site') { sendJson(res, 403, { ok: false, error: 'cross-site request denied' }); return }
      const contentType = req.headers?.['content-type']
      if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
        sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }

      let body: UnknownRecord
      try {
        const raw = await readBody(req)
        if (raw === null) { sendJson(res, 413, { ok: false, error: 'request body too large' }); return }
        body = raw ? asRecord(JSON.parse(raw)) : {}
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'invalid json body' })
        return
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      if (!sessionId || sessionId.length > 200) { sendJson(res, 400, { ok: false, error: 'valid sessionId is required' }); return }
      const action = typeof body.action === 'string' ? body.action : ''

      try {
        await dependencies.proposalStorageReady
        if (isRepositoryAction(action)) {
          sendJson(res, 200, await dispatchRepositoryAction(action, sessionId, body, dependencies))
          return
        }
        const response = await dispatchProposalAction(action, sessionId, body, dependencies)
        sendJson(res, response.status, response.data)
      } catch (error) {
        const diagnostics = redactAndLimit(errorMessage(error), 2000)
        sendJson(res, 500, isRepositoryAction(action)
          ? { ok: false, code: 'INTERNAL_ERROR', message: 'Git 操作失败', diagnostics }
          : { ok: false, error: diagnostics })
      }
    },
  })
}
