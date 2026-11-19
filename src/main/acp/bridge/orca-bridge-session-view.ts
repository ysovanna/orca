/** What the bridge publishes about a live card; the reply text is read separately. */
export type BridgeSessionState = 'running' | 'awaiting_gate' | 'done' | 'failed' | 'stopped'

export type BridgeGateRequest = {
  toolCallId: string
  title: string
  options: { optionId: string; name: string; kind: string }[]
}

export type BridgeSessionView = {
  id: string
  agent: string
  sessionId: string
  /** The model this session runs on: the COO's pin once carried, else null for the agent default. */
  model: string | null
  cwd: string
  state: BridgeSessionState
  stopReason: string | null
  error: string | null
  skipped: string[]
  pendingGate: BridgeGateRequest | null
}
