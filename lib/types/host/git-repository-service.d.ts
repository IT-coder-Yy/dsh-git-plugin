import type { ActionResult, CommitDetail, CommitDiffResult, CommitSummary, DiffResult, RepositoryReferences, RepositorySummary, StashSummary, StashDetail, SyncState } from '../shared/contracts';
export type { BranchSummary, CommitDetail, CommitDiffResult, CommitFileChange, CommitRefSummary, CommitSummary, DiffResult, ReferenceSummary, RepositoryFile, RepositoryReferences, RepositorySummary, StashSummary, SyncState, } from '../shared/contracts';
export interface GitRunResult {
    exitCode: number | null;
    signal?: string | null;
    timedOut?: boolean;
    aborted?: boolean;
    stdout?: {
        text?: string;
    };
    stderr?: {
        text?: string;
    };
}
export interface ShellService {
    resolve(request: Record<string, unknown>): unknown;
    run(specification: unknown): Promise<GitRunResult>;
}
interface MutationRequest {
    sessionId: string;
    workdir: string;
    operationId: unknown;
    signal?: AbortSignal;
    sandboxPolicy?: unknown;
}
export declare class GitRepositoryService {
    private readonly shell;
    private readonly locks;
    private readonly operations;
    constructor(shell: ShellService | undefined);
    run(workdir: string, command: string, timeoutMs?: number, stdoutMaxBytes?: number, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<GitRunResult>;
    getTopLevel(workdir: string, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<{
        topLevel: string;
    }>>;
    getSummary(workdir: string, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<RepositorySummary>>;
    getDiff(workdir: string, path: unknown, staged: boolean, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<DiffResult>>;
    getBranches(workdir: string, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<RepositoryReferences>>;
    getCommits(workdir: string, limit: unknown, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<CommitSummary[]>>;
    getCommitDetail(workdir: string, hash: unknown, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<CommitDetail>>;
    getCommitDiff(workdir: string, hash: unknown, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<CommitDiffResult>>;
    getStashes(workdir: string, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<StashSummary[]>>;
    private resolveStash;
    getStashDetail(workdir: string, selector: unknown, hash: unknown, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<StashDetail>>;
    getStashDiff(workdir: string, selector: unknown, hash: unknown, path: unknown, untracked: boolean, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<DiffResult>>;
    createStash(request: MutationRequest, message: unknown, paths: unknown, includeUntracked: boolean): Promise<ActionResult<RepositorySummary>>;
    mutateStash(request: MutationRequest, action: 'apply-stash' | 'pop-stash' | 'drop-stash' | 'branch-stash', selector: unknown, hash: unknown, name?: unknown, confirmRisk?: boolean): Promise<ActionResult<RepositorySummary>>;
    getSyncState(workdir: string, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<ActionResult<SyncState>>;
    fetchRemote(request: MutationRequest, remote: unknown): Promise<ActionResult<SyncState>>;
    pullFfOnly(request: MutationRequest): Promise<ActionResult<SyncState>>;
    pushCurrent(request: MutationRequest, remote: unknown, branch: unknown, setUpstream: boolean): Promise<ActionResult<SyncState>>;
    rebaseOnto(request: MutationRequest, target: unknown, confirmRisk: boolean): Promise<ActionResult<SyncState>>;
    continueRebase(request: MutationRequest, confirmRisk: boolean): Promise<ActionResult<SyncState>>;
    abortRebase(request: MutationRequest, confirmRisk: boolean): Promise<ActionResult<SyncState>>;
    stagePaths(request: MutationRequest, paths: unknown): Promise<ActionResult<RepositorySummary>>;
    unstagePaths(request: MutationRequest, paths: unknown): Promise<ActionResult<RepositorySummary>>;
    stageAll(request: MutationRequest): Promise<ActionResult<RepositorySummary>>;
    unstageAll(request: MutationRequest): Promise<ActionResult<RepositorySummary>>;
    commit(request: MutationRequest, message: unknown): Promise<ActionResult<RepositorySummary>>;
    createBranch(request: MutationRequest, name: unknown, base: unknown): Promise<ActionResult<RepositorySummary>>;
    switchBranch(request: MutationRequest, name: unknown): Promise<ActionResult<RepositorySummary>>;
    deleteBranch(request: MutationRequest, name: unknown, force: boolean, confirmRisk: boolean): Promise<ActionResult<RepositorySummary>>;
    private validatePaths;
    private mutate;
    private mutateSync;
    private mutateAndRead;
    conflictAction(action: string, workdir: string, payload: Record<string, unknown>, request?: MutationRequest, sandboxPolicy?: unknown): Promise<ActionResult<unknown>>;
    private withMutation;
    private pruneOperations;
}
