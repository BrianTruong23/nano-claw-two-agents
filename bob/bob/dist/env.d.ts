/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export declare function readEnvFile(keys: string[]): Record<string, string>;
export declare function readEnvValue(keys: string[]): string | undefined;
/**
 * Apply a small set of compatibility aliases from .env into process.env.
 * This keeps support for custom local key names while still presenting the
 * standard variable names expected by NanoClaw and the Claude Agent SDK.
 */
export declare function applySupportedEnvAliases(): void;
//# sourceMappingURL=env.d.ts.map