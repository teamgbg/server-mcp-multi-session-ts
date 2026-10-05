/**
 * @system mcp-multi-session
 * @status handwritten
 * @edit edit directly
 */

// 1. Locally-defined contract — NEVER import from the upstream package.
export interface InjectedLogger {
	error: (msg: string, ctx?: Record<string, unknown>) => void;
	warn: (msg: string, ctx?: Record<string, unknown>) => void;
	info: (msg: string, ctx?: Record<string, unknown>) => void;
	debug: (msg: string, ctx?: Record<string, unknown>) => void;
}

// 2. Default fallback. No-op so primitives load cleanly when bootloader
//    hasn't called configure() yet (tests, CLI invocations, etc.).
const noopLogger: InjectedLogger = {
	error: () => {},
	warn: () => {},
	info: () => {},
	debug: () => {},
};

// 3. Module-level state. The logger keeps the default singleton's identity
//    for the process lifetime (capture invariant,
//    reference/configured-primitives.md): modules capture
//    `const logger = getLogger()` at import time — BEFORE the bootloader
//    calls configure() — so configure() MUTATES it in place, never rebinds
//    it.
const _logger: InjectedLogger = noopLogger;

// 4. Bootloader calls this exactly once before any tier-1+ code runs.
export function configure(opts: { logger?: InjectedLogger }): void {
	if (opts.logger) Object.assign(_logger, opts.logger);
}

// 5. Internal getters — ALL mcp-multi-session call sites use these.
export function getLogger(): InjectedLogger {
	return _logger;
}
