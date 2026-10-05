/**
 * @system mcp-multi-session
 * @status handwritten
 * @edit edit directly
 */

import { type FSWatcher, watch } from "node:fs";
import { exponentialBackoff } from "@teamscala/retry/backoff";
import { withRetry } from "@teamscala/retry/with-retry";

const FORBIDDEN_OVERRIDE_PATTERN = /^(mcp-client|gemini-cli|codex-cli):[^:]+$/;
const MAX_OVERRIDE_LENGTH = 200;
const MAX_RETRY_ATTEMPTS = 12;

type ValidationResult =
	| { valid: true; value: string }
	| { valid: false; reason: "empty" | "too-long" | "forbidden-pattern" };

function validateOverride(value: string): ValidationResult {
	const trimmed = value.trim();
	if (!trimmed) return { valid: false, reason: "empty" };
	if (trimmed.length > MAX_OVERRIDE_LENGTH)
		return { valid: false, reason: "too-long" };
	if (FORBIDDEN_OVERRIDE_PATTERN.test(trimmed))
		return { valid: false, reason: "forbidden-pattern" };
	return { valid: true, value: trimmed };
}

interface PidOverrideEntry {
	value: string;
	watcher: FSWatcher | null;
}

const overrideMap = new Map<number, PidOverrideEntry>();

// Returns Promise<string | null> — it is async (awaits Bun.file().text()).
// The prior annotation `: string | null` was a type-lie that let callers use
// the result WITHOUT await, storing the unresolved Promise as overrideMap
// .value. getOrchSessionOverride then returned that Promise, which the
// gateway stamped into x-caller-orchestrator-session and HTTP-serialized to
// the literal "[object Promise]" — the ack-identity bug (#32, 2026-05-29).
async function readFileValue(filePath: string): Promise<string | null> {
	try {
		const raw = await Bun.file(filePath).text();
		const result = validateOverride(raw);
		return result.valid ? result.value : null;
	} catch {
		return null;
	}
}

function establishWatcher(pid: number, filePath: string): FSWatcher | null {
	const onChange = async () => {
		const value = await readFileValue(filePath);
		if (value !== null) {
			const existing = overrideMap.get(pid);
			overrideMap.set(pid, { value, watcher: existing?.watcher ?? null });
		} else {
			const existing = overrideMap.get(pid);
			existing?.watcher?.close();
			overrideMap.delete(pid);
		}
	};

	try {
		return watch(filePath, () => void onChange());
	} catch {
		return null;
	}
}

async function ensureWatching(pid: number): Promise<void> {
	if (overrideMap.has(pid)) return;

	const filePath = `/tmp/scala-orch-session-${pid}.txt`;

	const value = await readFileValue(filePath);
	if (value !== null) {
		const watcher = establishWatcher(pid, filePath);
		overrideMap.set(pid, { value, watcher });
		return;
	}

	// A missing override file is a NORMAL state — not every caller pane registers
	// an orchestrator-session override. withRetry exhausting its attempts MUST NOT
	// propagate: when this rejection escapes (callers invoke ensureWatching
	// fire-and-forget), it becomes an unhandledRejection that crash-loops the
	// fleet brain (scala-agents) — observed as ~1500 restarts on
	// "Override file not ready" (crash-isolation). Swallow the exhaustion; the
	// override simply stays absent for this pid until/unless the file appears.
	try {
		await withRetry(
			async () => {
				const v = await readFileValue(filePath);
				if (v === null) throw new Error(`Override file not ready: ${filePath}`);
				const watcher = establishWatcher(pid, filePath);
				overrideMap.set(pid, { value: v, watcher });
			},
			{
				maxAttempts: MAX_RETRY_ATTEMPTS,
				backoff: exponentialBackoff({ baseMs: 500, maxMs: 30_000, jitter: true }),
			},
		);
	} catch {
		// Override file never materialised within the retry budget → no override
		// for this pid. Non-fatal by design; getOrchSessionOverride returns null.
	}
}

export function getOrchSessionOverride(pid: number): string | null {
	// Fire-and-forget: populate the map + watcher for subsequent calls. The
	// current call returns whatever's already cached (null on first hit).
	// .value is always a resolved string now (readFileValue is awaited before
	// every overrideMap.set) — never a Promise.
	void ensureWatching(pid);
	return overrideMap.get(pid)?.value ?? null;
}

export function getOrchSessionOverrides(): Record<number, string> {
	const result: Record<number, string> = {};
	for (const [pid, entry] of overrideMap) {
		result[pid] = entry.value;
	}
	return result;
}

export function cleanupOverride(pid: number): void {
	const entry = overrideMap.get(pid);
	if (entry) {
		entry.watcher?.close();
		overrideMap.delete(pid);
	}
}

export function cleanupAllOverrides(): void {
	for (const [, entry] of overrideMap) {
		entry.watcher?.close();
	}
	overrideMap.clear();
}
