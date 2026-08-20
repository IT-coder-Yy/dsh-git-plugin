import { randomUUID } from 'node:crypto'
import type { GitFailureContext, ProposalStatus, ProposalView } from '../shared/contracts'
export type { ProposalView } from '../shared/contracts'
import type { RiskLevel } from './command-policy'

export interface ProposalStep {
  command: string
  result: Record<string, unknown> | null
}

export interface StoredProposal {
  proposalId: string
  sessionId: string
  intent: string
  command: string
  steps: ProposalStep[]
  explanation: string
  risk: RiskLevel
  reasons: string[]
  confirmed: boolean
  workdir: string
  createdAt: number
  status: ProposalStatus
  closed: boolean
  copied: boolean
  fingerprint: string | null
  verified: boolean
  result: Record<string, unknown> | null
  failure?: GitFailureContext
  [key: string]: unknown
}

export interface ProposalStorageUnit {
  loadAll(): Promise<{
    tables: Record<string, Record<string, unknown>>
    global: unknown
  }>
  putRecord(table: string, key: string, value: unknown): Promise<void>
  deleteRecord(table: string, key: string): Promise<void>
  close(): Promise<void>
}

const DEFAULT_PROPOSALS_PER_SESSION = 3
const DEFAULT_MAX_SESSIONS = 100
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000

export class ProposalService {
  private readonly proposalsBySession = new Map<string, StoredProposal[]>()
  private storage: ProposalStorageUnit | null = null
  private storageTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly proposalsPerSession = DEFAULT_PROPOSALS_PER_SESSION,
    private readonly maxSessions = DEFAULT_MAX_SESSIONS,
    private readonly sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  ) {}

  async attachStorage(storage: ProposalStorageUnit): Promise<void> {
    const snapshot = await storage.loadAll()
    const records = snapshot.tables.proposals ?? {}
    const loaded = new Map<string, StoredProposal[]>()
    for (const [sessionId, value] of Object.entries(records)) {
      const entries = this.readStoredEntries(sessionId, value)
      if (entries.length > 0) loaded.set(sessionId, entries)
    }
    this.pruneMap(loaded)
    for (const [sessionId, entries] of this.proposalsBySession) {
      if (!loaded.has(sessionId)) loaded.set(sessionId, entries)
    }
    this.proposalsBySession.clear()
    for (const [sessionId, entries] of loaded) this.proposalsBySession.set(sessionId, entries)
    this.storage = storage
  }

  async closeStorage(storage: ProposalStorageUnit): Promise<void> {
    await this.storageTail
    if (this.storage === storage) this.storage = null
    await storage.close()
  }

  flush(sessionId: string): Promise<void> {
    const storage = this.storage
    if (!storage) return Promise.resolve()
    const entries = this.proposalsBySession.get(sessionId)
    const operation = entries && entries.length > 0
      ? () => storage.putRecord('proposals', sessionId, { entries })
      : () => storage.deleteRecord('proposals', sessionId)
    const result = this.storageTail.then(operation)
    this.storageTail = result.catch(() => {})
    return result
  }

  newId(): string {
    return 'g-' + randomUUID()
  }

  list(sessionId: string): StoredProposal[] | undefined {
    this.prune()
    return this.proposalsBySession.get(sessionId)
  }

  hasRunning(sessionId: string): boolean {
    return this.list(sessionId)?.some((proposal) => proposal.status === 'running') ?? false
  }

  closeOpen(sessionId: string): void {
    for (const proposal of this.list(sessionId) ?? []) if (!proposal.closed) proposal.closed = true
  }

  store(sessionId: string, proposal: StoredProposal): StoredProposal {
    this.prune()
    let list = this.proposalsBySession.get(sessionId)
    if (!list) {
      list = []
      this.proposalsBySession.set(sessionId, list)
    } else {
      this.proposalsBySession.delete(sessionId)
      this.proposalsBySession.set(sessionId, list)
    }
    list.unshift(proposal)
    if (list.length > this.proposalsPerSession) list.length = this.proposalsPerSession
    while (this.proposalsBySession.size > this.maxSessions) {
      const oldest = [...this.proposalsBySession].find(([, entries]) => entries.every((entry) => entry.status !== 'running'))?.[0]
      if (!oldest) break
      this.proposalsBySession.delete(oldest)
    }
    return proposal
  }

  prune(now = Date.now()): void {
    this.pruneMap(this.proposalsBySession, now)
  }

  private pruneMap(proposals: Map<string, StoredProposal[]>, now = Date.now()): void {
    for (const [sessionId, entries] of proposals) {
      const newest = entries[0]
      if (!newest || (now - newest.createdAt > this.sessionTtlMs && entries.every((entry) => entry.status !== 'running'))) proposals.delete(sessionId)
    }
  }

  private readStoredEntries(sessionId: string, value: unknown): StoredProposal[] {
    if (!isRecord(value) || !Array.isArray(value.entries)) return []
    const entries: StoredProposal[] = []
    for (const item of value.entries.slice(0, this.proposalsPerSession)) {
      if (!isStoredProposal(item, sessionId)) continue
      if (item.status === 'running') {
        entries.push({
          ...item,
          status: 'failed',
          closed: true,
          result: { ok: false, error: 'DSH 在命令执行期间停止，无法确认命令是否完整执行' },
        })
      } else {
        entries.push(item)
      }
    }
    return entries
  }

  find(sessionId: string, proposalId: unknown): StoredProposal | undefined {
    if (typeof proposalId !== 'string' || !proposalId) return undefined
    return this.list(sessionId)?.find((proposal) => proposal.proposalId === proposalId)
  }

  latestPending(sessionId: string): StoredProposal | null {
    for (const proposal of this.list(sessionId) ?? []) if (!proposal.closed) return proposal
    return null
  }

  view(proposal: StoredProposal): ProposalView {
    return {
      proposalId: proposal.proposalId,
      intent: proposal.intent,
      command: proposal.command,
      steps: proposal.steps.map((step) => ({ command: step.command, result: step.result })),
      explanation: proposal.explanation,
      risk: proposal.risk,
      reasons: proposal.reasons,
      confirmed: proposal.confirmed,
      workdir: proposal.workdir,
      result: proposal.result,
      closed: proposal.closed,
      copied: proposal.copied,
      ...(proposal.failure ? { failure: proposal.failure } : {}),
      ...(typeof proposal.recoverySuggestion === 'string' ? { recoverySuggestion: proposal.recoverySuggestion } : {}),
      ...(proposal.needsAgentAnalysis === true ? { needsAgentAnalysis: true } : {}),
      ...(typeof proposal.analysisRequestedAt === 'number' ? { analysisRequestedAt: proposal.analysisRequestedAt } : {}),
      status: proposal.status || (proposal.closed ? 'dismissed' : 'pending'),
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isGitFailureContext(value: unknown): value is GitFailureContext {
  if (!isRecord(value)) return false
  return (value.source === 'workbench' || value.source === 'proposal')
    && typeof value.code === 'string'
    && typeof value.action === 'string'
    && typeof value.command === 'string'
    && typeof value.message === 'string'
    && typeof value.stdout === 'string'
    && typeof value.stderr === 'string'
    && typeof value.diagnostics === 'string'
    && (value.exitCode === null || (typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode)))
    && typeof value.timedOut === 'boolean'
    && typeof value.mayHavePartialChanges === 'boolean'
    && typeof value.occurredAt === 'number'
    && Number.isSafeInteger(value.occurredAt)
}

function isStoredProposal(value: unknown, sessionId: string): value is StoredProposal {
  if (!isRecord(value) || value.sessionId !== sessionId) return false
  if (typeof value.proposalId !== 'string' || !/^g-[0-9a-f-]{36}$/i.test(value.proposalId)) return false
  if (typeof value.intent !== 'string' || typeof value.command !== 'string' || typeof value.explanation !== 'string') return false
  if (typeof value.workdir !== 'string' || typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt)) return false
  if (!['safe', 'normal', 'hard'].includes(String(value.risk))) return false
  if (!['pending', 'running', 'succeeded', 'failed', 'verified', 'dismissed'].includes(String(value.status))) return false
  if (!Array.isArray(value.reasons) || !value.reasons.every((reason) => typeof reason === 'string')) return false
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 10) return false
  if (!value.steps.every((step) => isRecord(step) && typeof step.command === 'string' && (step.result === null || isRecord(step.result)))) return false
  return typeof value.confirmed === 'boolean'
    && typeof value.closed === 'boolean'
    && typeof value.copied === 'boolean'
    && typeof value.verified === 'boolean'
    && (value.fingerprint === null || typeof value.fingerprint === 'string')
    && (value.result === null || isRecord(value.result))
    && (value.failure === undefined || isGitFailureContext(value.failure))
    && (value.recoverySuggestion === undefined || typeof value.recoverySuggestion === 'string')
    && (value.needsAgentAnalysis === undefined || typeof value.needsAgentAnalysis === 'boolean')
    && (value.analysisRequestedAt === undefined || (typeof value.analysisRequestedAt === 'number' && Number.isSafeInteger(value.analysisRequestedAt)))
}

export const proposalService = new ProposalService()
