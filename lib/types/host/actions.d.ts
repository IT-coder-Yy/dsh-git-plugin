import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProposalView } from '../shared/contracts';
import { deriveChecks } from './command-policy';
import type { GitRepositoryService, ShellService } from './git-repository-service';
import type { StoredProposal } from './proposal-service';
type UnknownRecord = Record<string, unknown>;
export interface WebServerService {
    register(definition: {
        kind: 'prefix';
        path: string;
        handler(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }): unknown;
}
interface ProposalVerification {
    changed: boolean;
    verified: boolean;
    partial: boolean;
    message: string;
    changedState: string;
}
interface EasyGitActionDependencies {
    repository: GitRepositoryService;
    proposalStorageReady: Promise<void>;
    shell: ShellService | null;
    repositoryContext(sessionId: string): {
        workdir: string;
        policy: unknown;
    } | null;
    latestPending(sessionId: string): StoredProposal | null;
    findProposal(sessionId: string, proposalId: unknown): StoredProposal | undefined;
    proposalView(proposal: StoredProposal): ProposalView;
    flushProposal(sessionId: string): Promise<void>;
    captureFingerprint(shell: ShellService | null, workdir: string): Promise<string | null>;
    runChecks(shell: ShellService | null, workdir: string, checks: ReturnType<typeof deriveChecks>): Promise<string[]>;
    verifyProposal(shell: ShellService | null, proposal: StoredProposal): Promise<ProposalVerification>;
    executeProposal(shell: ShellService | null, proposal: StoredProposal, policy: unknown, persist: () => Promise<void>): Promise<UnknownRecord>;
    resolveExecutionPolicy(sessionId: string): unknown;
}
/** Register the Client-to-Host POST dispatcher with a 1 MiB body limit. */
export declare function registerEasyGitActions(webServer: WebServerService | null, dependencies: EasyGitActionDependencies): unknown;
export {};
