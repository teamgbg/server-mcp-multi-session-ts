/**
 * @system codegen
 * @status generated
 * @edit change the module's exports, then re-run codegen. Hand-edits are overwritten.
 *
 * The configured-primitive contract for this package, derived from the module's
 * OWN exported surface rather than from a registry row — the row does not
 * describe the code, and routing this through one would make a local testing
 * concern depend on a deployed service.
 */

import { expect, test } from "bun:test";
import { configure, getLogger } from "../configure.ts";



test("getLogger() keeps one object identity across configure() calls", () => {
	const captured = getLogger();
	configure({ logger: captured } as never);
	expect(getLogger()).toBe(captured);
});

test("a reference captured BEFORE configure() observes the injected logger", () => {
	// The half identity alone cannot prove: the stable object must DELEGATE to
	// whatever was injected, or a pre-configure capture keeps talking to the
	// no-op forever with nothing failing.
	const captured = getLogger() as unknown as Record<string, (...args: never[]) => unknown>;
	// Every member this case overwrites is captured first and configured back
	// on the way out: bun test runs every file in ONE process, so a case that
	// injects without restoring hands every later suite its recorder.
	const previous: Record<string, unknown> = {};
	for (const name of ["ctx", "debug", "error", "info", "msg", "warn"]) previous[name] = captured[name];
	const seen: string[] = [];
	configure({
		logger: {
			ctx: ((...args: never[]) => {
				seen.push("ctx");
				return undefined;
			}) as never,
		debug: (() => undefined) as never,
		error: (() => undefined) as never,
		info: (() => undefined) as never,
		msg: (() => undefined) as never,
		warn: (() => undefined) as never,
		},
	} as never);
	captured["ctx"]?.();
	expect(seen).toContain("ctx");
	configure({ logger: previous } as never);
});
