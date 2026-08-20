/** Shared Client-to-Host contracts. */
export type ProposalStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'verified' | 'dismissed';
export type ActionErrorCode = 'NOT_GIT_REPOSITORY' | 'SESSION_NOT_FOUND' | 'INVALID_ARGUMENT' | 'STATE_CONFLICT' | 'OPERATION_DUPLICATE' | 'GIT_FAILED' | 'TIMEOUT' | 'PERMISSION_DENIED' | 'INTERNAL_ERROR';
export type ActionFailureReason = 'CURRENT_BRANCH' | 'BRANCH_NOT_FOUND' | 'BRANCH_EXISTS' | 'UNMERGED_BRANCH' | 'NO_REMOTE' | 'NO_UPSTREAM' | 'DETACHED_HEAD' | 'DIRTY_WORKTREE' | 'CONFLICTS_PRESENT' | 'REBASE_IN_PROGRESS' | 'NO_REBASE_IN_PROGRESS' | 'REF_NOT_FOUND';
export interface GitFailureContext {
    source: 'workbench' | 'proposal';
    code: string;
    action: string;
    command: string;
    message: string;
    stdout: string;
    stderr: string;
    diagnostics: string;
    exitCode: number | null;
    timedOut: boolean;
    mayHavePartialChanges: boolean;
    occurredAt: number;
}
export interface RecoveryProposal {
    suggestion: string;
    command: string;
    proposalId: string | null;
}
export interface AgentAnalysisRequest {
    proposalId: string;
}
export type ActionResult<T> = {
    ok: true;
    data: T;
    operationId?: string;
} | {
    ok: false;
    code: ActionErrorCode;
    message: string;
    diagnostics?: string;
    reason?: ActionFailureReason;
    failure?: GitFailureContext;
    recovery?: RecoveryProposal;
    analysis?: AgentAnalysisRequest;
};
export interface RepositoryFile {
    indexStatus: string;
    workTreeStatus: string;
    path: string;
    originalPath?: string;
}
export interface RepositorySummary {
    topLevel: string;
    branch: string;
    head: string;
    status: string;
    files: RepositoryFile[];
    stagedCount: number;
}
export interface SyncState {
    topLevel: string;
    branch: string;
    head: string;
    upstream: string;
    remotes: string[];
    ahead: number;
    behind: number;
    dirty: boolean;
    conflictCount: number;
    rebaseInProgress: boolean;
    files: RepositoryFile[];
}
export interface BranchSummary {
    name: string;
    current: boolean;
    upstream: string;
}
export interface ReferenceSummary {
    name: string;
    hash: string;
    subject: string;
}
export interface RepositoryReferences {
    branches: BranchSummary[];
    remotes: ReferenceSummary[];
    tags: ReferenceSummary[];
}
export interface CommitRefSummary {
    name: string;
    type: 'branch' | 'remote' | 'tag';
    current: boolean;
}
export interface CommitSummary {
    hash: string;
    parents: string[];
    subject: string;
    author: string;
    date: string;
    refs: CommitRefSummary[];
}
export interface CommitFileChange {
    status: string;
    path: string;
    previousPath?: string;
    additions: number | null;
    deletions: number | null;
}
export interface CommitDetail {
    hash: string;
    parents: string[];
    subject: string;
    body: string;
    authorName: string;
    authorEmail: string;
    authoredAt: string;
    committerName: string;
    committerEmail: string;
    committedAt: string;
    comparisonBase: string | null;
    files: CommitFileChange[];
    filesTruncated: boolean;
    totals: {
        files: number;
        additions: number;
        deletions: number;
        binary: number;
    };
}
export interface CommitDiffResult {
    hash: string;
    comparisonBase: string | null;
    diff: string;
    truncated: boolean;
}
export interface StashSummary {
    selector: string;
    hash: string;
    subject: string;
    author: string;
    date: string;
}
export interface DiffResult {
    path: string | null;
    staged: boolean;
    diff: string;
    truncated: boolean;
}
export interface ProposalStepView {
    command: string;
    result: Record<string, unknown> | null;
}
export interface ProposalView {
    proposalId: string;
    status: ProposalStatus;
    risk: 'safe' | 'normal' | 'hard';
    command: string;
    intent: string;
    steps: ProposalStepView[];
    explanation: string;
    reasons: string[];
    confirmed: boolean;
    workdir: string;
    result: Record<string, unknown> | null;
    closed: boolean;
    copied: boolean;
    failure?: GitFailureContext;
    recoverySuggestion?: string;
    needsAgentAnalysis?: boolean;
    analysisRequestedAt?: number;
}
export type ProposalStateResponse = {
    ok: true;
    proposal: ProposalView | null;
    changed: boolean;
    verified: boolean;
    partial: boolean;
    message: string;
    changedState: string;
} | {
    ok: false;
    error: string;
};
export interface ProposalCommandResponse {
    ok: boolean;
    error?: string;
    changed?: boolean;
    verified?: boolean;
    partial?: boolean;
    message?: string;
    changedState?: string;
}
export interface ProposalExecutionResponse extends ProposalCommandResponse {
    proposalId?: string;
    command?: string;
    steps?: Array<{
        command: string;
        ok: boolean;
        exitCode?: number;
    }>;
    exitCode?: number;
    signal?: string;
    timedOut?: boolean;
    stdout?: string;
    stderr?: string;
    diagnostics?: string;
    failure?: GitFailureContext;
    recovery?: RecoveryProposal | null;
    analysis?: AgentAnalysisRequest;
}
export interface EasyGitRequestMap {
    'get-summary': {
        sessionId: string;
    };
    'get-diff': {
        sessionId: string;
        path: string;
        staged: boolean;
    };
    'get-branches': {
        sessionId: string;
    };
    'get-commits': {
        sessionId: string;
        limit?: number;
    };
    'get-commit-detail': {
        sessionId: string;
        hash: string;
    };
    'get-commit-diff': {
        sessionId: string;
        hash: string;
    };
    'get-stashes': {
        sessionId: string;
    };
    'get-sync-state': {
        sessionId: string;
    };
    'stage-paths': {
        sessionId: string;
        operationId: string;
        paths: string[];
    };
    'unstage-paths': {
        sessionId: string;
        operationId: string;
        paths: string[];
    };
    'stage-all': {
        sessionId: string;
        operationId: string;
    };
    'unstage-all': {
        sessionId: string;
        operationId: string;
    };
    commit: {
        sessionId: string;
        operationId: string;
        message: string;
    };
    'create-branch': {
        sessionId: string;
        operationId: string;
        name: string;
        base?: string;
    };
    'switch-branch': {
        sessionId: string;
        operationId: string;
        name: string;
    };
    'delete-branch': {
        sessionId: string;
        operationId: string;
        name: string;
        force?: boolean;
        confirmRisk?: boolean;
    };
    fetch: {
        sessionId: string;
        operationId: string;
        remote: string;
    };
    pull: {
        sessionId: string;
        operationId: string;
    };
    push: {
        sessionId: string;
        operationId: string;
        remote?: string;
        branch?: string;
        setUpstream?: boolean;
    };
    rebase: {
        sessionId: string;
        operationId: string;
        target: string;
        confirmRisk?: boolean;
    };
    'rebase-continue': {
        sessionId: string;
        operationId: string;
        confirmRisk?: boolean;
    };
    'rebase-abort': {
        sessionId: string;
        operationId: string;
        confirmRisk?: boolean;
    };
    'request-analysis': {
        sessionId: string;
        proposalId: string;
    };
    state: {
        sessionId: string;
    };
    dismiss: {
        sessionId: string;
        proposalId: string;
        manual?: boolean;
    };
    'mark-copied': {
        sessionId: string;
        proposalId: string;
        confirm?: boolean;
    };
    verify: {
        sessionId: string;
        proposalId: string;
    };
    execute: {
        sessionId: string;
        proposalId: string;
        confirm?: boolean;
    };
}
export interface EasyGitResponseMap {
    'get-summary': ActionResult<RepositorySummary>;
    'get-diff': ActionResult<DiffResult>;
    'get-branches': ActionResult<RepositoryReferences>;
    'get-commits': ActionResult<CommitSummary[]>;
    'get-commit-detail': ActionResult<CommitDetail>;
    'get-commit-diff': ActionResult<CommitDiffResult>;
    'get-stashes': ActionResult<StashSummary[]>;
    'get-sync-state': ActionResult<SyncState>;
    'stage-paths': ActionResult<RepositorySummary>;
    'unstage-paths': ActionResult<RepositorySummary>;
    'stage-all': ActionResult<RepositorySummary>;
    'unstage-all': ActionResult<RepositorySummary>;
    commit: ActionResult<RepositorySummary>;
    'create-branch': ActionResult<RepositorySummary>;
    'switch-branch': ActionResult<RepositorySummary>;
    'delete-branch': ActionResult<RepositorySummary>;
    fetch: ActionResult<SyncState>;
    pull: ActionResult<SyncState>;
    push: ActionResult<SyncState>;
    rebase: ActionResult<SyncState>;
    'rebase-continue': ActionResult<SyncState>;
    'rebase-abort': ActionResult<SyncState>;
    'request-analysis': ProposalCommandResponse;
    state: ProposalStateResponse;
    dismiss: ProposalCommandResponse;
    'mark-copied': ProposalCommandResponse;
    verify: ProposalCommandResponse;
    execute: ProposalExecutionResponse;
}
export type EasyGitAction = keyof EasyGitRequestMap;
export type EasyGitRequest<A extends EasyGitAction = EasyGitAction> = {
    action: A;
} & EasyGitRequestMap[A];
export type EasyGitResponse<A extends EasyGitAction> = EasyGitResponseMap[A];
