import type { BranchSummary, CommitSummary, RepositoryFile } from '../shared/contracts';
export type AnyRecord = Record<string, any>;
export type RepositoryMutationAction = 'stage-paths' | 'unstage-paths' | 'stage-all' | 'unstage-all' | 'commit' | 'create-branch' | 'switch-branch' | 'delete-branch';
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
export interface HostSplitLayout {
    frame: HTMLElement;
    sidebar: HTMLElement;
    center: HTMLElement;
    details: HTMLElement;
}
export interface ActiveHostSplit {
    layout: HostSplitLayout;
    splitColumns: string;
    previousGridTemplateColumns: string;
    previousTrack: string;
    previousDetailsWidth: string;
    previousDetailsMinWidth: string;
    previousDetailsMaxWidth: string;
    previousDetailsBorderLeft: string;
}
export interface ResizeDrag {
    pointerId: number;
    startX: number;
    startWidth: number;
    currentRatio: number;
}
export declare const WORKBENCH_RATIO_KEY = "dsh-easygit-plugin:workbench-ratio";
export declare const WORKBENCH_TRACK = "--dsh-easygit-plugin-workbench-width";
export declare const WORKBENCH_DEFAULT_RATIO = 0.36;
export declare const WORKBENCH_MIN_RATIO = 0.24;
export declare const WORKBENCH_MAX_RATIO = 0.75;
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
export declare function clampWorkbenchRatio(value: number): number;
export declare function readWorkbenchRatio(): number;
export declare function persistWorkbenchRatio(value: number | null): void;
export declare function workbenchTrackForRatio(ratio: number): string;
export declare function repositoryName(topLevel: unknown): string;
export declare function mutationCommand(action: string, payload?: AnyRecord): {
    label: string;
    command: string;
} | null;
export declare function viewportWidth(): number;
export declare function sidebarTrackWidth(layout: HostSplitLayout): number;
export declare function findWorkbenchHostSplit(anchor: HTMLElement): HostSplitLayout | null;
export declare function buildFileTree(files: RepositoryFile[]): FileTreeNode;
export declare function parseReviewRows(diff: string): ReviewRow[];
export declare function diffLineClass(line: string): string;
