import type { EasyGitAction, EasyGitRequest, EasyGitResponse } from '../shared/contracts';
export declare function rpc<A extends EasyGitAction>(body: EasyGitRequest<A>, signal?: AbortSignal): Promise<EasyGitResponse<A>>;
