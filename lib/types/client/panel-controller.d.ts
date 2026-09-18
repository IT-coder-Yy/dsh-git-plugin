import type { AnyRecord } from './view-model';
export type Dispose = () => void;
/** Use the session-scoped conversation service; Connection no longer owns domain APIs. */
export declare function requestAgentAnalysis(sessions: AnyRecord, sessionId: string, text: string): Promise<void>;
/** Register a native tab without taking over the host's layout or other tabs. */
export declare function registerWorkbench(ctx: AnyRecord, renderPanel: (props: {
    sessionId: string;
    close: Dispose;
    sendPrompt(text: string): Promise<void>;
}) => unknown): (sessionId: string) => void;
