import type { EasyGitAction, EasyGitRequest, EasyGitResponse } from '../shared/contracts';
interface Props {
    sessionId: string;
    revision: number;
    rpc<A extends EasyGitAction>(request: EasyGitRequest<A>, signal?: AbortSignal): Promise<EasyGitResponse<A>>;
    onChanged(): void;
    onDirty(dirty: boolean): void;
    onCommand(label: string, command: string): (success: boolean) => void;
}
export declare function GitConflictsTab(props: Props): import("react").DetailedReactHTMLElement<{
    className: string;
    'aria-label': string;
}, HTMLElement>;
export {};
