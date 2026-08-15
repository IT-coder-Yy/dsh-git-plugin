export type Dispose = () => void;
export interface PanelSnapshot {
    detailsReady: boolean;
    activeSessionId: string | null;
    open: boolean;
    error: string;
}
export interface PanelController {
    attachDetails(): Dispose;
    open(sessionId: unknown): boolean;
    close(sessionId?: unknown): boolean;
    toggle(sessionId: unknown): boolean;
    isOpen(sessionId: unknown): boolean;
    subscribe(listener: (state: PanelSnapshot) => void): Dispose;
    snapshot(): PanelSnapshot;
}
interface SlotsLike {
    register(definition: Record<string, unknown>, renderer: (props: Record<string, unknown>) => unknown): unknown;
}
interface LayoutLike {
    openDetails(): void;
    closeDetails(): void;
}
export interface PanelControllerOptions {
    slots?: SlotsLike | null;
    layout?: LayoutLike | null;
    renderPanel: (props: {
        sessionId: string;
        close: Dispose;
    }) => unknown;
}
/**
 * Mount the workbench only while it is open. Harness's built-in DetailsPanel
 * uses priority 0, so the workbench temporarily overrides it at -10 and
 * immediately releases the registration when closed.
 */
export declare function createPanelController(options: PanelControllerOptions): PanelController;
export {};
