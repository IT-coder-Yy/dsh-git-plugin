import type { AnyRecord } from './view-model';
export declare const sideChatSessions: Set<string>;
export declare function openSideChat(sessionId: string): Promise<string>;
export declare function EmbeddedChat(props: AnyRecord): unknown;
export declare function SideChat({ sessionId, sessions, SessionProvider, renderSlot, collapsed }: AnyRecord): unknown;
