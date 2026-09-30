type Runtime = Record<string, any>;
/** Native DSH sessions own history; this service owns only parent links and synchronization. */
export declare class SideChatService {
    private readonly ctx;
    private readonly links;
    private readonly jobs;
    private readonly configured;
    private storage?;
    readonly ready: Promise<void>;
    constructor(ctx: Runtime);
    private load;
    parentOf(sessionId: string): string | undefined;
    private serial;
    private configure;
    open(parent: string): Promise<{
        ok: true;
        sessionId: string;
    }>;
    private delta;
    feedback(parent: string, proposalId: string, result: unknown): Promise<void>;
}
export {};
