import type { ActionResult } from '../shared/contracts';
import type { GitRepositoryService } from './git-repository-service';
interface ModelSelection {
    provider: string;
    model: string;
    reasoningEffort?: string;
}
interface ModelServices {
    sessionQuery: {
        observeSession(id: string): Promise<{
            projections?: {
                values: {
                    modelSelection?: {
                        next?: ModelSelection;
                    };
                };
            };
            [Symbol.dispose](): void;
        }>;
    };
    agentDefaultModel: {
        currentSelection(): ModelSelection;
    };
    llm: {
        stream(options: ModelSelection & {
            system: string;
            messages: Array<{
                role: 'user';
                content: Array<{
                    type: 'text';
                    text: string;
                }>;
            }>;
            signal: AbortSignal;
        }): AsyncIterable<{
            type: string;
            text?: string;
            reason?: {
                kind: string;
                failure?: {
                    message: string;
                };
            };
        }>;
    };
}
export declare function generateCommitMessage(ctx: {
    get<K extends keyof ModelServices>(name: K): ModelServices[K];
}, repository: GitRepositoryService, sessionId: string, workdir: string, policy: unknown): Promise<ActionResult<{
    message: string;
}>>;
export {};
