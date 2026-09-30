import type { AnyRecord } from './view-model';
export declare const sideChatSessions: Set<string>;
export declare function openSideChat(sessionId: string): Promise<string>;
/** Same native Conversation factory used by DSH's sidebar subagent chat. */
export declare function EmbeddedChat(props: AnyRecord): unknown;
export declare function SideChat({ sessionId, sessions, SessionProvider, renderSlot }: AnyRecord): unknown;
