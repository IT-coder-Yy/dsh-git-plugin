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
import type { GitFailureContext } from '../shared/contracts';
import { ProposalService, type ProposalView, type StoredProposal } from './proposal-service';
import { GitRepositoryService, type ShellService } from './git-repository-service';
import { addPathsOf, classifyRisk, classifyStepsRisk, deriveChecks, modernizeCommand, parseCommand, quoteShellArg, redactAndLimit, redactSecrets, validateCommand, type ExpectedCheck } from './command-policy';
type UnknownRecord = Record<string, unknown>;
interface HostContext {
    get<T = unknown>(name: string): T;
    inject?(services: string[], callback: (context: HostContext) => unknown): unknown;
    effect?(callback: () => () => void | Promise<void>): unknown;
}
interface ProposalExecutionResult extends UnknownRecord {
    ok: boolean;
    proposalId: string;
    command: string;
    steps: Array<{
        command: string;
        ok: boolean;
        exitCode: number;
    }>;
    exitCode: number;
    signal: string;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    diagnostics: string;
    failure?: GitFailureContext;
    recovery?: {
        suggestion: string;
        command: string;
        proposalId: string | null;
    } | null;
    analysis?: {
        proposalId: string;
    };
    error: string;
}
interface ProposalVerification {
    changed: boolean;
    verified: boolean;
    partial: boolean;
    message: string;
    changedState: string;
}
interface RecoverySuggestion {
    suggestion: string;
    command: string | null;
    proposalId?: string;
}
declare function captureFingerprint(shell: ShellService | null | undefined, workdir: string): Promise<string | null>;
declare function captureDiagnostics(shell: ShellService | null | undefined, workdir: string): Promise<string>;
declare function runChecks(shell: ShellService | null | undefined, workdir: string, checks: readonly ExpectedCheck[]): Promise<string[]>;
declare function verifyProposal(shell: ShellService | null | undefined, proposal: StoredProposal): Promise<ProposalVerification>;
declare function executeProposalSteps(shell: ShellService, proposal: StoredProposal, signal?: AbortSignal, policy?: unknown): Promise<{
    ok: boolean;
    stepsResult: Array<{
        command: string;
        ok: boolean;
        exitCode: number;
    }>;
}>;
declare function executeRegisteredProposal(shell: ShellService | null | undefined, proposal: StoredProposal | null | undefined, signal?: AbortSignal, policy?: unknown, persistStatus?: () => Promise<void>): Promise<ProposalExecutionResult>;
/**
 * Derive a safe recovery command from a failed step and repository diagnostics.
 * A null command means the condition requires manual remediation.
 */
declare function buildRecovery(_proposal: StoredProposal, failedStep: StoredProposal['steps'][number] | undefined, diagnostics: string): RecoverySuggestion | null;
declare function buildRecoveryForCommand(cmd: string, text: string, reason?: string): RecoverySuggestion | null;
declare function recoverFailedCommand(activeShell: ShellService | null | undefined, sessionId: string, workdir: string, operationId: string, action: string, command: string, message: string, errorOutput: string, errorCode: string, reason: string): Promise<{
    failure: GitFailureContext;
    recovery?: {
        suggestion: string;
        command: string;
        proposalId: string | null;
    };
    analysis?: {
        proposalId: string;
    };
} | null>;
/** Register a recovery command as a pending proposal in the same session. */
declare function registerRecoveryProposal(failedProposal: Pick<StoredProposal, 'sessionId' | 'workdir'>, recovery: RecoverySuggestion, failure?: GitFailureContext): StoredProposal | null;
declare function storeProposal(sessionId: string, proposal: StoredProposal): StoredProposal;
declare function findProposal(sessionId: string, proposalId: unknown): StoredProposal | undefined;
declare function proposalView(proposal: StoredProposal): ProposalView;
declare function latestPending(sessionId: string): StoredProposal | null;
declare const _default: {
    name: string;
    inject: string[];
    apply(ctx: HostContext): void;
} & {
    helpers: {
        parseCommand: typeof parseCommand;
        validateCommand: typeof validateCommand;
        modernizeCommand: typeof modernizeCommand;
        classifyRisk: typeof classifyRisk;
        classifyStepsRisk: typeof classifyStepsRisk;
        quoteShellArg: typeof quoteShellArg;
        redactSecrets: typeof redactSecrets;
        redactAndLimit: typeof redactAndLimit;
        addPathsOf: typeof addPathsOf;
        deriveChecks: typeof deriveChecks;
        runChecks: typeof runChecks;
        verifyProposal: typeof verifyProposal;
        captureFingerprint: typeof captureFingerprint;
        captureDiagnostics: typeof captureDiagnostics;
        executeProposalSteps: typeof executeProposalSteps;
        executeRegisteredProposal: typeof executeRegisteredProposal;
        buildRecovery: typeof buildRecovery;
        buildRecoveryForCommand: typeof buildRecoveryForCommand;
        recoverFailedCommand: typeof recoverFailedCommand;
        registerRecoveryProposal: typeof registerRecoveryProposal;
        storeProposal: typeof storeProposal;
        findProposal: typeof findProposal;
        proposalView: typeof proposalView;
        latestPending: typeof latestPending;
        ProposalService: typeof ProposalService;
        GitRepositoryService: typeof GitRepositoryService;
    };
};
export = _default;
