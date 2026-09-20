import type { BranchSummary, CommitSummary, GitFailureContext, RepositoryFile } from '../shared/contracts';
export type AnyRecord = Record<string, any>;
export type RepositoryMutationAction = 'stage-paths' | 'unstage-paths' | 'stage-all' | 'unstage-all' | 'commit' | 'create-branch' | 'switch-branch' | 'delete-branch' | 'create-stash' | 'apply-stash' | 'pop-stash' | 'drop-stash' | 'branch-stash';
export interface CommandLogEntry {
    id: number;
    label: string;
    command: string;
    status: 'running' | 'succeeded' | 'failed';
}
export interface RequestSlot {
    controller: AbortController | null;
    sequence: number;
}
export interface TrackedRequest {
    sequence: number;
    signal: AbortSignal;
}
export interface FileTreeNode {
    name: string;
    path: string;
    folders: FileTreeNode[];
    files: RepositoryFile[];
}
export interface ReviewRow {
    kind: 'context' | 'added' | 'deleted' | 'skipped' | 'annotation';
    oldNumber: number | null;
    newNumber: number | null;
    text: string;
}
export interface CommitGraphEdge {
    from: number;
    to: number | null;
    active: boolean;
}
export interface CommitGraphRow {
    commit: CommitSummary;
    lane: number;
    laneCount: number;
    edges: CommitGraphEdge[];
}
export declare function appendCommandLog(current: CommandLogEntry[], entry: CommandLogEntry): CommandLogEntry[];
export declare function filterLocalBranches(branches: BranchSummary[], query: string): BranchSummary[];
export declare function isCurrentCommitRequest(selectedHash: string, requestedHash: string, currentSequence: number, requestSequence: number): boolean;
export declare function nextCommitSelection(currentHash: string, requestedHash: string): string;
export declare function commitFileTone(status: string): string;
export declare function isLatestRequest(currentSequence: number, requestSequence: number): boolean;
export declare function beginTrackedRequest(ref: {
    current: RequestSlot;
}): TrackedRequest;
export declare function cancelTrackedRequest(ref: {
    current: RequestSlot;
}): void;
export declare function isTrackedRequestCurrent(ref: {
    current: RequestSlot;
}, request: TrackedRequest): boolean;
export declare function isAbortError(error: unknown): boolean;
export declare function deriveCommitGraph(commits: CommitSummary[]): CommitGraphRow[];
export declare function repositoryName(topLevel: unknown): string;
export declare function mutationCommand(action: string, payload?: AnyRecord): {
    label: string;
    command: string;
} | null;
export declare function recoveryProposalId(response: unknown): string | null;
export declare function analysisProposalId(response: unknown): string | null;
export declare function failureContext(response: unknown): GitFailureContext | null;
export declare function buildAgentRepairPrompt(failure: GitFailureContext): string;
export declare function shouldShowAnalysisBanner(tab: string, pendingAnalysis: unknown): boolean;
export declare function canDismissFailedProposal(needsAgentAnalysis: unknown): boolean;
export declare function pendingProposalTransition(previousProposalId: string | null, proposal: unknown): {
    proposalId: string | null;
    shouldOpen: boolean;
};
export declare function openRecoveryProposal(response: unknown, open: () => void, schedule?: (callback: () => void, delayMs: number) => unknown): boolean;
export declare function buildFileTree(files: RepositoryFile[]): FileTreeNode;
export declare function parseReviewRows(diff: string): ReviewRow[];
export declare function diffLineClass(line: string): string;
