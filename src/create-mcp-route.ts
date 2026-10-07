/**
 * @system mcp-multi-session
 * @status handwritten
 * @edit edit directly
 *
 * Stateless MCP HTTP route factory. Builds a caller-info snapshot from
 * incoming request headers and the per-PID override file surface
 * (/tmp/scala-orch-session-${pid}.txt), then runs the MCP handler inside
 * AsyncLocalStorage so downstream code reads a stable identity per request.
 */
/**
 * A header value carrying an env-var template (`${SCALA_ORCH_SESSION_ID}`)
 * is one the CLIENT failed to expand — OpenCode and Codex don't substitute
 * env vars in MCP header values, unlike Claude Code.
 *
 * The gateway MUST NOT expand it server-side: the template names the
 * CLIENT's env var, but `process.env` here is the GATEWAY's environment.
 * The gateway carries its own sentinel `SCALA_ORCH_SESSION_ID=tmux:%gateway`,
 * so server-side expansion mis-attributed EVERY unexpanded caller to
 * `tmux:%gateway` — collapsing all OpenCode/Codex panes to one identity and
 * making per-pane routing (and OpenCode→orchestrator replies) impossible.
 * Incident: 2026-05-29, root-caused from `ackedBy: tmux:%gateway` in
 * event_log.
 *
 * Correct behaviour: an unexpanded-template header is treated as ABSENT.
 * Resolution falls through to the /proc-walk path (resolveCallerLabel),
 * which reads the CALLER's own `/proc/<pid>/environ` for the real
 * SCALA_ORCH_SESSION_ID — the only env that actually belongs to the caller.
 */

import { CALLER_HEADERS } from "@teamscala/os/contracts/mcp";
import { createTimer } from "@teamscala/timing/create-timer";
import {
	type CallerInfo,
	callerContextAsyncLocalStorage,
} from "./caller-context.ts";
import { getOrchSessionOverride } from "@teamscala/caller-label/orch-session-override";
import { resolveCallerLabel } from "@teamscala/caller-label/resolve-caller-label";

const FORBIDDEN_HOST_ONLY = /^(mcp-client|gemini-cli|codex-cli|shell):[^:]+$/;
const ENV_VAR_TEMPLATE_RE = /\$\{(\w+)\}/;

function isUnexpandedTemplate(value: string): boolean {
	return ENV_VAR_TEMPLATE_RE.test(value);
}

function headerValueOrNull(raw: string | null): string | null {
	if (!raw) return null;
	if (isUnexpandedTemplate(raw)) return null;
	return raw;
}

/** The per-request context a handler receives: the request itself plus its headers. */
export type McpRequestExtra = {
	requestInfo?: { headers: Headers };
};

function headerValue(headers: Headers | undefined, name: string): string | null {
	return headers?.get(name) ?? null;
}

/**
 * Derive the caller identity from a request's headers. Named for what it reads
 * (headers), not for the transport that used to supply them: the SDK is gone
 * and a name that names it would outlive the thing it names. Takes the
 * standard `Headers` every web runtime already carries, so nothing has to
 * reshape a request into a transport's own header record first.
 */
export async function buildCallerInfoFromHeaders(
	headers: Headers | undefined,
): Promise<CallerInfo> {
	const rawOrch = headerValueOrNull(
		headerValue(headers, CALLER_HEADERS.ORCHESTRATOR_SESSION),
	);
	const orch =
		rawOrch && !FORBIDDEN_HOST_ONLY.test(rawOrch) ? rawOrch : null;
	const rawTmux = headerValueOrNull(
		headerValue(headers, CALLER_HEADERS.TMUX_TARGET),
	);
	const tmux = rawTmux;
	const label = headerValue(headers, CALLER_HEADERS.LABEL);
	const session = headerValue(headers, CALLER_HEADERS.SESSION);
	const remotePortStr = headerValue(headers, CALLER_HEADERS.REMOTE_PORT);
	// Org scope is caller-supplied and only ever FORWARDED downstream — never
	// defaulted. An absent header stays null so the org-scoped tool rejects
	// rather than silently reading some system org. An UNEXPANDED TEMPLATE
	// (${MCP_SYSTEM_ORG_ID} — a CLI whose launch env lacked the variable) is
	// also absent, by the same doctrine as the orchestrator-session header:
	// the gateway cannot expand a client-env placeholder, and a template that
	// flows through becomes a written organisation id (measured 2026-08-31 —
	// a work_items.create carried the literal '${MCP_SYSTEM_ORG_ID}' into the
	// Prisma invocation). Absent stays loud: the write the caller needed
	// refuses naming the missing identity instead of persisting junk.
	const organisationId = headerValueOrNull(
		headerValue(headers, CALLER_HEADERS.ORGANISATION),
	);
	// Identity is read on the same terms as org: forwarded, never defaulted. An
	// absent header stays null so the downstream resolves NO user rather than a
	// default one — and it is a CLAIM, not a grant: privilege must come from the
	// stored role, never from this header being present.
	const callerUserId = headerValue(headers, CALLER_HEADERS.USER);
	const callerAgentId = headerValue(headers, CALLER_HEADERS.AGENT);

	// Authoritative source per `single-notification-source` invariant #2:
	// a CONCRETE x-caller-orchestrator-session header (already expanded by the
	// client, as Claude Code does) is the truth. Unexpanded `${...}` templates
	// were filtered to null above (headerValueOrNull) — they CANNOT be trusted
	// because the gateway has no access to the client's env, only its own. For
	// those callers (OpenCode, Codex) the /proc-walk path below reads the
	// caller's own environ, which is the only correct source.
	if (orch || tmux) {
		const orchestratorId = (orch || tmux) as string;
		const orchestratorType = orch ? "orchestrator_session" : "tmux";
		return {
			label: label || null,
			tmuxSession: session || null,
			tmuxTarget: tmux || null,
			orchestratorSessionId: orch || null,
			callerPid: null,
			orchestratorId,
			orchestratorType,
			organisationId: organisationId || null,
			userId: callerUserId || null,
			agentId: callerAgentId || null,
			rawOrchSession: rawOrch || null,
			rawTmuxTarget: rawTmux || null,
		};
	}

	// Header didn't carry a valid orch; fall through to the /proc-walk path,
	// which throws structurally if the caller's process tree env is also bad.
	// That throw is the fail-loud surface for genuinely-misconfigured callers
	// (no header AND no env) — exactly what `no-shims` prescribes.
	if (remotePortStr) {
		const remotePort = parseInt(remotePortStr, 10);
		if (Number.isFinite(remotePort) && remotePort > 0) {
			const resolved = await resolveCallerLabel(remotePort);
			const override = resolved?.callerPid
				? getOrchSessionOverride(resolved.callerPid)
				: null;
			if (resolved && (resolved.orchestratorSessionId || resolved.tmuxTarget)) {
				const resolvedOrch = override ?? resolved.orchestratorSessionId;
				const orchestratorId = resolvedOrch || resolved.tmuxTarget!;
				const orchestratorType = resolvedOrch ? "orchestrator_session" : "tmux";
				return {
					label: resolved.label || label || null,
					tmuxSession: resolved.tmuxSession || session || null,
					tmuxTarget: resolved.tmuxTarget || null,
					orchestratorSessionId: resolvedOrch || null,
					callerPid: resolved.callerPid || null,
					orchestratorId,
					orchestratorType,
					organisationId: organisationId || null,
					userId: callerUserId || null,
					agentId: callerAgentId || null,
				};
			}
		}
	}

	return {
		label: label || null,
		tmuxSession: session || null,
		tmuxTarget: tmux || null,
		orchestratorSessionId: null,
		callerPid: null,
		orchestratorId: null,
		orchestratorType: null,
		organisationId: organisationId || null,
		userId: callerUserId || null,
		agentId: callerAgentId || null,
	};
}

export type RequestHandlerSchema = unknown;
export type RequestHandler = (
	request: unknown,
	extra: McpRequestExtra,
) => Promise<unknown> | unknown;

export interface McpRouteConfig {
	requestHandlers: Array<{
		method: string;
		handler: RequestHandler;
	}>;
	/** Called once on the first POST handled by this route. Use for one-shot global wiring. */
	onFirstSession?: () => void | Promise<void>;
	/** Compatibility no-ops in stateless mode (no per-session lifecycle to hook). */
	onSessionInitialized?: (sessionId: string) => void;
	onSessionClosed?: (sessionId: string) => void;
}

export interface McpRouteHandle {
	handle: (request: Request) => Promise<Response>;
	/** Always 0 — stateless. Kept for API compatibility. */
	sessionCount: () => number;
	/** Always []. Kept for API compatibility. */
	sessionIds: () => string[];
	/** No-op in stateless mode. Kept for API compatibility. */
	broadcastToolListChanged: () => Promise<void>;
}

export function createMcpRoute(config: McpRouteConfig): McpRouteHandle {
	let firstFired = false;

	// Method name -> handler. The SDK matched a request by validating it against
	// a Zod schema; on a stateless route a method-name match is the same
	// dispatch with no schema to keep in step with it.
	const handlers = new Map(config.requestHandlers.map((h) => [h.method, h.handler]));

	function jsonRpc(id: unknown, result: unknown): Response {
		return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}

	function jsonRpcError(id: unknown, code: number, message: string): Response {
		return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}

	// Latency breakdown via the timing primitive (timing-is-the-only-timing).
	// The stateless route has one measured segment — dispatch — because the
	// per-request SDK transport/server/connect/close cycle it used to time no
	// longer exists. A timer for a step nothing performs is a lie in a header.
	const totalTimer = createTimer("mcp-multi-session:route-total");
	const segmentTimers = {
		dispatch: createTimer("mcp-multi-session:dispatch"),
	};

	async function handle(request: Request): Promise<Response> {
		const spans: Array<[string, number]> = [];
		const { result: response, durationMs: totalMs } = await totalTimer.timeAsyncRead(
			async (): Promise<Response> => {
				const method = request.method.toUpperCase();

				if (method === "GET" || method === "DELETE") {
					return new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							error: {
								code: -32000,
								message: "Method not allowed in stateless mode.",
							},
							id: null,
						}),
						{ status: 405, headers: { "content-type": "application/json" } },
					);
				}

				if (!firstFired) {
					firstFired = true;
					await config.onFirstSession?.();
				}

				const { result: dispatched, durationMs: dDispatch } =
					await segmentTimers.dispatch.timeAsyncRead(async () => {
						let message: { id?: unknown; method?: string; params?: unknown };
						try {
							message = await request.json();
						} catch {
							return jsonRpcError(null, -32700, "Parse error");
						}
						const { id, method, params } = message;
						// A notification carries no id and expects no body. The SDK
						// answered 202 for these; a JSON-RPC error body for a
						// notification is not a reply to anything.
						if (id === undefined || id === null) {
							const handler = method ? handlers.get(method) : undefined;
							if (handler) {
								const callerInfo = await buildCallerInfoFromHeaders(request.headers);
								await callerContextAsyncLocalStorage.run(callerInfo, () =>
									handler(params, { requestInfo: { headers: request.headers } }),
								);
							}
							return new Response(null, { status: 202 });
						}
						const handler = method ? handlers.get(method) : undefined;
						if (!handler) {
							return jsonRpcError(
								id,
								-32601,
								`Method not found: ${String(method)}`,
							);
						}
						// Request metadata enters ALS at the handler boundary; the
						// HTTP route owns no parallel identity parser.
						const callerInfo = await buildCallerInfoFromHeaders(request.headers);
						try {
							const result = await callerContextAsyncLocalStorage.run(callerInfo, () =>
								handler(params, { requestInfo: { headers: request.headers } }),
							);
							return jsonRpc(id, result ?? null);
						} catch (err) {
							return jsonRpcError(
								id,
								-32603,
								err instanceof Error ? err.message : String(err),
							);
						}
					});
				spans.push(["dispatch", dDispatch]);

				return dispatched;
			},
		);

		spans.push(["total", totalMs]);
		const timingHeader = spans
			.map(([k, ms]) => `${k};dur=${ms.toFixed(2)}`)
			.join(", ");
		try {
			response.headers.set("Server-Timing", timingHeader);
		} catch {}
		return response;
	}

	return {
		handle,
		sessionCount: () => 0,
		sessionIds: () => [],
		broadcastToolListChanged: async () => {},
	};
}
