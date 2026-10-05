/**
 * @system mcp-multi-session
 * @status handwritten
 * @edit edit directly
 */

export interface CallerInfo {
	label: string | null;
	tmuxSession: string | null;
	tmuxTarget: string | null;
	orchestratorSessionId: string | null;
	callerPid: number | null;
}
