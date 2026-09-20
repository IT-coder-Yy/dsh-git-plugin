import type { EasyGitAction, EasyGitRequest, EasyGitResponse } from '../shared/contracts';
interface Props {
    sessionId: string;
    revision: number;
    rpc<A extends EasyGitAction>(request: EasyGitRequest<A>, signal?: AbortSignal): Promise<EasyGitResponse<A>>;
    onChanged(): void;
    onConflicts(): void;
    onCommand(label: string, command: string): (success: boolean) => void;
    renderReview(diff: string): React.ReactNode;
    renderRawDiff(diff: string): React.ReactNode;
}
export declare function GitStashesTab(props: Props): import("react").DetailedReactHTMLElement<{
    className: string;
}, HTMLElement>;
export {};
