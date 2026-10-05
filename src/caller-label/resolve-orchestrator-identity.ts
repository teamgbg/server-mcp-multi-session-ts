/**
 * @system mcp-multi-session
 * @status handwritten
 * @edit edit directly
 */


const TMUX_PANE_RE = /^%(\d+)$/;

export function resolveOrchestratorIdentity(
	tmuxPane: string | undefined | null,
	orchSessionId: string | undefined | null,
	report: (message: string) => void = () => {
	},
): string | null {
	const paneRaw = typeof tmuxPane === "string" ? tmuxPane.trim() : "";
	const m = TMUX_PANE_RE.exec(paneRaw);
	if (m) {
		// TMUX_PANE is canonical: tmux sets it per-pane and overrides any leaked
		// server value, so a process carrying it IS this pane and no other.
		// m[0] is the full `%<digits>` match — keep the `%` so the identity is
		// `tmux:%17`, the grammar every consumer matches against.
		const canonical = `tmux:${m[0]}`;
		const inherited =
			typeof orchSessionId === "string" && orchSessionId.length > 0
				? orchSessionId
				: null;
		if (inherited && inherited !== canonical) {
			// Report every time, matching resolveDatabaseUrl: a silent override
			// trades one invisible identity for another, and the cost here was
			// never the wrong value — it was that nothing anywhere said the two
			// sources disagreed while three panes quietly shared one id. The
			// report is telemetry: it must never convert a stale identity into a
			// crash, so a broken reporter is swallowed.
			try {
				report(
					`ignoring inherited SCALA_ORCH_SESSION_ID=${inherited}: canonical pane identity is ${canonical} (derived from TMUX_PANE). An inherited tmux:%N value on this host is usually a stale leak from the tmux server env, captured from session-picker's supervised environment — see scrubTmuxServerIdentityEnv.`,
				);
			} catch {
			}
		}
		return canonical;
	}
	// No TMUX_PANE — the process is not in a tmux pane (a dashboard caller, an
	// SSH-attached CLI, a fleet shared-server lane). The leak only ever
	// produces `tmux:%N` values, and TMUX_PANE is the guard against those, so
	// the inherited SCALA_ORCH_SESSION_ID is the only signal here and is
	// trustworthy: an attested `opencode:fleet`/`<binary>:detached` id, or
	// legitimately unset.
	return typeof orchSessionId === "string" && orchSessionId.length > 0
		? orchSessionId
		: null;
}
