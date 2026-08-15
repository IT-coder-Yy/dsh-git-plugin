export type RiskLevel = 'safe' | 'normal' | 'hard';
export interface ParsedCommand {
    ok: true;
    args: string[];
    subcommand: string;
    normalized: string;
}
export interface InvalidCommand {
    ok: false;
    error: string;
}
export type ParseResult = ParsedCommand | InvalidCommand;
export interface RiskAssessment {
    level: RiskLevel;
    reasons: string[];
}
export interface ModernizedCommand {
    command: string;
    changed: boolean;
}
export interface ExpectedCheck {
    type: 'branch' | 'branch-gone' | 'commit-msg' | 'staged' | 'clean' | 'stash-nonempty' | 'stash-empty' | 'no-ahead';
    value: string | string[] | boolean;
    label: string;
}
export declare const MAX_COMMAND_LENGTH = 800;
export declare function quoteShellArg(value: unknown): string;
export declare function parseCommand(command: unknown): ParseResult;
export declare function validateCommand(command: unknown): ParseResult & {
    segments?: string[];
};
export declare function modernizeCommand(command: unknown): ModernizedCommand;
export declare function classifyRisk(command: unknown): RiskAssessment;
export declare function classifyStepsRisk(commands: readonly string[]): RiskAssessment;
export declare function redactSecrets(value: unknown): string;
export declare function redactAndLimit(value: unknown, maxChars?: number): string;
export declare function addPathsOf(command: string): string | null;
export declare function deriveChecks(commands: readonly string[]): ExpectedCheck[];
