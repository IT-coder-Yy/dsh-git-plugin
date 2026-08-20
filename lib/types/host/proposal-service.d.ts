import type { GitFailureContext, ProposalStatus, ProposalView } from '../shared/contracts';
export type { ProposalView } from '../shared/contracts';
import type { RiskLevel } from './command-policy';
export interface ProposalStep {
    command: string;
    result: Record<string, unknown> | null;
}
export interface StoredProposal {
    proposalId: string;
    sessionId: string;
    intent: string;
    command: string;
    steps: ProposalStep[];
    explanation: string;
    risk: RiskLevel;
    reasons: string[];
    confirmed: boolean;
    workdir: string;
    createdAt: number;
    status: ProposalStatus;
    closed: boolean;
    copied: boolean;
    fingerprint: string | null;
    verified: boolean;
    result: Record<string, unknown> | null;
    failure?: GitFailureContext;
    [key: string]: unknown;
}
export interface ProposalStorageUnit {
    loadAll(): Promise<{
        tables: Record<string, Record<string, unknown>>;
        global: unknown;
    }>;
    putRecord(table: string, key: string, value: unknown): Promise<void>;
    deleteRecord(table: string, key: string): Promise<void>;
    close(): Promise<void>;
}
export declare class ProposalService {
    private readonly proposalsPerSession;
    private readonly maxSessions;
    private readonly sessionTtlMs;
    private readonly proposalsBySession;
    private storage;
    private storageTail;
    constructor(proposalsPerSession?: number, maxSessions?: number, sessionTtlMs?: number);
    attachStorage(storage: ProposalStorageUnit): Promise<void>;
    closeStorage(storage: ProposalStorageUnit): Promise<void>;
    flush(sessionId: string): Promise<void>;
    newId(): string;
    list(sessionId: string): StoredProposal[] | undefined;
    hasRunning(sessionId: string): boolean;
    closeOpen(sessionId: string): void;
    store(sessionId: string, proposal: StoredProposal): StoredProposal;
    prune(now?: number): void;
    private pruneMap;
    private readStoredEntries;
    find(sessionId: string, proposalId: unknown): StoredProposal | undefined;
    latestPending(sessionId: string): StoredProposal | null;
    view(proposal: StoredProposal): ProposalView;
}
export declare const proposalService: ProposalService;
