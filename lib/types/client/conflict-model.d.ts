export interface ConflictBlock {
    start: number;
    end: number;
    ours: string;
    base: string | null;
    theirs: string;
}
/** Keep byte-for-byte text boundaries, including CRLF and a missing final newline. */
export declare function parseConflictBlocks(text: string, markerSize?: number): ConflictBlock[];
export declare function chooseConflictBlock(text: string, block: ConflictBlock, choice: 'ours' | 'theirs' | 'both'): string;
