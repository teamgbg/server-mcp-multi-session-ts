/**
 * @system mcp-multi-session
 * @status handwritten
 * @edit edit directly
 */

import { ManagedCache } from "@teamscala/cache/cache";
import type { CallerInfo } from "./types.ts";

export const CACHE_TTL_MS = 60_000;
export const CACHE_MAX_ENTRIES = 4096;

export const callerCache = new ManagedCache<CallerInfo>("caller-label", {
	ttlMs: CACHE_TTL_MS,
	maxSize: CACHE_MAX_ENTRIES,
});
