import type { EasyGitAction, EasyGitRequest, EasyGitResponse } from '../shared/contracts';
interface Props {
    sessionId: string;
    revision: number;
    hash?: string;
    parents?: string[];
    disabled?: boolean;
    rpc<A extends EasyGitAction>(request: EasyGitRequest<A>, signal?: AbortSignal): Promise<EasyGitResponse<A>>;
    onChanged(): void;
    onConflicts(): void;
    onBusy?(busy: boolean): void;
    onCommand(label: string, command: string): (success: boolean) => void;
}
export declare function GitCommitActions(props: Props): import("react").DetailedReactHTMLElement<{
    className: string;
    'aria-label': string;
}, HTMLElement>;
export {};
