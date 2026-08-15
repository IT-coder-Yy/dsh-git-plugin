/** Shared Client-to-Host contracts. */

export type ProposalStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'verified' | 'dismissed'

export type ActionErrorCode =
  | 'NOT_GIT_REPOSITORY'
  | 'SESSION_NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'STATE_CONFLICT'
  | 'OPERATION_DUPLICATE'
  | 'GIT_FAILED'
  | 'TIMEOUT'
  | 'PERMISSION_DENIED'
  | 'INTERNAL_ERROR'

export type ActionFailureReason = 'CURRENT_BRANCH' | 'BRANCH_NOT_FOUND' | 'UNMERGED_BRANCH'

export type ActionResult<T> =
  | { ok: true; data: T; operationId?: string }
  | { ok: false; code: ActionErrorCode; message: string; diagnostics?: string; reason?: ActionFailureReason }

export interface RepositoryFile {
  indexStatus: string
  workTreeStatus: string
  path: string
  originalPath?: string
}

export interface RepositorySummary {
  topLevel: string
  branch: string
  head: string
  status: string
  files: RepositoryFile[]
  stagedCount: number
}

export interface BranchSummary {
  name: string
  current: boolean
  upstream: string
}

export interface ReferenceSummary {
  name: string
  hash: string
  subject: string
}

export interface RepositoryReferences {
  branches: BranchSummary[]
  remotes: ReferenceSummary[]
  tags: ReferenceSummary[]
}

export interface CommitRefSummary {
  name: string
  type: 'branch' | 'remote' | 'tag'
  current: boolean
}

export interface CommitSummary {
  hash: string
  parents: string[]
  subject: string
  author: string
  date: string
  refs: CommitRefSummary[]
}

export interface CommitFileChange {
  status: string
  path: string
  previousPath?: string
  additions: number | null
  deletions: number | null
}

export interface CommitDetail {
  hash: string
  parents: string[]
  subject: string
  body: string
  authorName: string
  authorEmail: string
  authoredAt: string
  committerName: string
  committerEmail: string
  committedAt: string
  comparisonBase: string | null
  files: CommitFileChange[]
  filesTruncated: boolean
  totals: { files: number; additions: number; deletions: number; binary: number }
}

export interface CommitDiffResult {
  hash: string
  comparisonBase: string | null
  diff: string
  truncated: boolean
}

export interface StashSummary {
  selector: string
  hash: string
  subject: string
  author: string
  date: string
}

export interface DiffResult {
  path: string | null
  staged: boolean
  diff: string
  truncated: boolean
}

export interface ProposalStepView {
  command: string
  result: Record<string, unknown> | null
}

export interface ProposalView {
  proposalId: string
  status: ProposalStatus
  risk: 'safe' | 'normal' | 'hard'
  command: string
  intent: string
  steps: ProposalStepView[]
  explanation: string
  reasons: string[]
  confirmed: boolean
  workdir: string
  result: Record<string, unknown> | null
  closed: boolean
  copied: boolean
}

export type ProposalStateResponse =
  | {
      ok: true
      proposal: ProposalView | null
      changed: boolean
      verified: boolean
      partial: boolean
      message: string
      changedState: string
    }
  | { ok: false; error: string }

export interface ProposalCommandResponse {
  ok: boolean
  error?: string
  changed?: boolean
  verified?: boolean
  partial?: boolean
  message?: string
  changedState?: string
}

export interface ProposalExecutionResponse extends ProposalCommandResponse {
  proposalId?: string
  command?: string
  steps?: Array<{ command: string; ok: boolean; exitCode?: number }>
  exitCode?: number
  signal?: string
  timedOut?: boolean
  stdout?: string
  stderr?: string
  diagnostics?: string
  recovery?: { suggestion: string; command: string; proposalId: string | null } | null
}

export interface GitGuideRequestMap {
  'get-summary': { sessionId: string }
  'get-diff': { sessionId: string; path: string; staged: boolean }
  'get-branches': { sessionId: string }
  'get-commits': { sessionId: string; limit?: number }
  'get-commit-detail': { sessionId: string; hash: string }
  'get-commit-diff': { sessionId: string; hash: string }
  'get-stashes': { sessionId: string }
  'stage-paths': { sessionId: string; operationId: string; paths: string[] }
  'unstage-paths': { sessionId: string; operationId: string; paths: string[] }
  'stage-all': { sessionId: string; operationId: string }
  'unstage-all': { sessionId: string; operationId: string }
  commit: { sessionId: string; operationId: string; message: string }
  'create-branch': { sessionId: string; operationId: string; name: string; base?: string }
  'switch-branch': { sessionId: string; operationId: string; name: string }
  'delete-branch': { sessionId: string; operationId: string; name: string; force?: boolean; confirmRisk?: boolean }
  state: { sessionId: string }
  dismiss: { sessionId: string; proposalId: string; manual?: boolean }
  'mark-copied': { sessionId: string; proposalId: string; confirm?: boolean }
  verify: { sessionId: string; proposalId: string }
  execute: { sessionId: string; proposalId: string; confirm?: boolean }
}

export interface GitGuideResponseMap {
  'get-summary': ActionResult<RepositorySummary>
  'get-diff': ActionResult<DiffResult>
  'get-branches': ActionResult<RepositoryReferences>
  'get-commits': ActionResult<CommitSummary[]>
  'get-commit-detail': ActionResult<CommitDetail>
  'get-commit-diff': ActionResult<CommitDiffResult>
  'get-stashes': ActionResult<StashSummary[]>
  'stage-paths': ActionResult<RepositorySummary>
  'unstage-paths': ActionResult<RepositorySummary>
  'stage-all': ActionResult<RepositorySummary>
  'unstage-all': ActionResult<RepositorySummary>
  commit: ActionResult<RepositorySummary>
  'create-branch': ActionResult<RepositorySummary>
  'switch-branch': ActionResult<RepositorySummary>
  'delete-branch': ActionResult<RepositorySummary>
  state: ProposalStateResponse
  dismiss: ProposalCommandResponse
  'mark-copied': ProposalCommandResponse
  verify: ProposalCommandResponse
  execute: ProposalExecutionResponse
}

export type GitGuideAction = keyof GitGuideRequestMap
export type GitGuideRequest<A extends GitGuideAction = GitGuideAction> = { action: A } & GitGuideRequestMap[A]
export type GitGuideResponse<A extends GitGuideAction> = GitGuideResponseMap[A]
