export interface ArchitectureRule {
  readonly directory: string;
  readonly reason: string;
  readonly forbidden: readonly string[];
}

export declare const ARCHITECTURE_RULES: readonly ArchitectureRule[];
export declare function matchesForbiddenPattern(specifier: string, pattern: string): boolean;
