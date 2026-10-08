import { GitConflictsTab } from './conflict-tab';
import { GitStashesTab } from './stash-tab';
import { GitMergeTab } from './merge-tab';
import { GitCommitActions } from './commit-actions';
import { parseConflictBlocks, chooseConflictBlock, conflictLineRanges } from './conflict-model';
import { registerWorkbench, type Dispose } from './panel-controller';
import { appendCommandLog, analysisProposalId, beginTrackedRequest, buildAgentRepairPrompt, canDismissFailedProposal, buildFileTree, cancelTrackedRequest, commitFileTone, deriveCommitGraph, filterLocalBranches, failureContext, isCurrentCommitRequest, isLatestRequest, isTrackedRequestCurrent, mutationCommand, nextCommitSelection, openRecoveryProposal, parseReviewRows, pendingProposalTransition, recoveryProposalId, repositoryName, shouldShowAnalysisBanner, type AnyRecord } from './view-model';
type TimerFn = (callback: () => void, delayMs: number) => Dispose | void;
interface GitWorkbenchPanelProps {
    sessionId: string;
    close: Dispose;
    renderChat(expanded: boolean): unknown;
    intervalFn?: TimerFn | null;
    timeoutFn?: TimerFn | null;
}
interface GitDockProps {
    sessionId?: unknown;
    onFailure: FailureHandler;
    onCommand?: CommandReporter;
    intervalFn?: TimerFn | null;
    timeoutFn?: TimerFn | null;
}
interface RepositoryTabProps {
    onConflicts(): void;
    sessionId: string;
    intervalFn?: TimerFn | null;
    revision: number;
    onChanged: Dispose;
    onCommand: CommandReporter;
    onFailure: FailureHandler;
}
type CommandReporter = (label: string, command: string) => (succeeded: boolean) => void;
type FailureHandler = (response: AnyRecord) => void;
type RefreshState = 'idle' | 'loading' | 'succeeded' | 'failed';
declare function injectStyles(): () => void;
declare function refreshButtonLabel(state: RefreshState): string;
declare function renderRawDiffSurface(diff: string): any;
declare function renderReviewSurface(diff: string): any;
declare function GitChangesTab(props: RepositoryTabProps): any;
declare function GitWorkbenchPanel(props: GitWorkbenchPanelProps): any;
declare function GitDock(props: GitDockProps): any;
declare const plugin: {
    inject: string[];
    apply(ctx: AnyRecord): void;
    __testing: {
        GitDock: typeof GitDock;
        GitWorkbenchPanel: typeof GitWorkbenchPanel;
        GitChangesTab: typeof GitChangesTab;
        GitCommitActions: typeof GitCommitActions;
        GitMergeTab: typeof GitMergeTab;
        GitStashesTab: typeof GitStashesTab;
        GitConflictsTab: typeof GitConflictsTab;
        parseConflictBlocks: typeof parseConflictBlocks;
        chooseConflictBlock: typeof chooseConflictBlock;
        conflictLineRanges: typeof conflictLineRanges;
        registerWorkbench: typeof registerWorkbench;
        buildFileTree: typeof buildFileTree;
        parseReviewRows: typeof parseReviewRows;
        renderRawDiffSurface: typeof renderRawDiffSurface;
        renderReviewSurface: typeof renderReviewSurface;
        injectStyles: typeof injectStyles;
        filterLocalBranches: typeof filterLocalBranches;
        deriveCommitGraph: typeof deriveCommitGraph;
        repositoryName: typeof repositoryName;
        mutationCommand: typeof mutationCommand;
        appendCommandLog: typeof appendCommandLog;
        refreshButtonLabel: typeof refreshButtonLabel;
        recoveryProposalId: typeof recoveryProposalId;
        openRecoveryProposal: typeof openRecoveryProposal;
        analysisProposalId: typeof analysisProposalId;
        failureContext: typeof failureContext;
        buildAgentRepairPrompt: typeof buildAgentRepairPrompt;
        shouldShowAnalysisBanner: typeof shouldShowAnalysisBanner;
        canDismissFailedProposal: typeof canDismissFailedProposal;
        pendingProposalTransition: typeof pendingProposalTransition;
        isCurrentCommitRequest: typeof isCurrentCommitRequest;
        nextCommitSelection: typeof nextCommitSelection;
        commitFileTone: typeof commitFileTone;
        isLatestRequest: typeof isLatestRequest;
        beginTrackedRequest: typeof beginTrackedRequest;
        cancelTrackedRequest: typeof cancelTrackedRequest;
        isTrackedRequestCurrent: typeof isTrackedRequestCurrent;
    };
};
export = plugin;
