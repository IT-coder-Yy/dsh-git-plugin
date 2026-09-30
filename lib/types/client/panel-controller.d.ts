import type { AnyRecord } from './view-model';
export type Dispose = () => void;
/** Register a native tab without taking over the host's layout or other tabs. */
export declare function registerWorkbench(ctx: AnyRecord, renderPanel: (props: {
    sessionId: string;
    close: Dispose;
    renderChat(expanded: boolean): unknown;
}) => unknown): (sessionId: string) => void;
