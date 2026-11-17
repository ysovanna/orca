// One live bridge session: the agent child, its streamed reply, and the gate the COO must answer.

import { randomUUID } from 'node:crypto'
import type { AcpStructuredConnection } from '../process/acp-structured-connection'
import type { AcpSessionEvent } from '../protocol/acp-session-events'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse
} from '../generated/acp-protocol.generated'
import {
  BRIDGE_TEXT_LIMIT,
  noteBridgeSessionOffer,
  planBridgeStart,
  planBridgeSteer,
  planBridgeTurn,
  readBridgeCapabilities,
  type BridgeAgentCapabilities,
  type BridgeCard,
  type BridgePlan
} from './orca-bridge-card-plan'
import type {
  BridgeGateRequest,
  BridgeSessionState,
  BridgeSessionView
} from './orca-bridge-session-view'

const BRIDGE_OPTION_TIMEOUT_MS = 30_000

/** The agent child, its streamed reply, and the gate the COO must answer. */
export class BridgeAcpSession {
  readonly id = randomUUID()
  readonly agent: string
  readonly cwd: string
  state: BridgeSessionState = 'running'
  text = ''
  stopReason: string | null = null
  error: string | null = null
  readonly skipped: string[] = []
  pendingGate: BridgeGateRequest | null = null
  private caps: BridgeAgentCapabilities
  private acpSessionId = ''
  private gate: { settle: (allow: boolean) => void } | null = null
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly spec: AcpLaunchSpec,
    private readonly card: BridgeCard,
    private readonly authMethodId: string | null,
    private readonly connection: AcpStructuredConnection
  ) {
    this.agent = spec.agent
    this.cwd = card.cwd ?? ''
    this.caps = readBridgeCapabilities(spec, {})
  }

  /** initialize → authenticate → session/new; the child is live and addressable after this. */
  async start(signal?: AbortSignal): Promise<void> {
    this.unsubscribe = this.connection.subscribe((event) => this.collect(event))
    try {
      await this.run(planBridgeStart(this.card, this.authMethodId), signal)
    } catch (error) {
      this.fail(error)
      throw error
    }
  }

  /** The card's first prompt turn; the child stays open afterwards so the COO can steer. */
  async runCard(signal?: AbortSignal): Promise<void> {
    try {
      await this.run(planBridgeTurn(this.card, this.caps, this.acpSessionId), signal)
    } catch (error) {
      this.fail(error)
      throw error
    }
  }

  /** COO follow-up as another prompt turn; the session runtime queues it behind the live turn. */
  async steer(text: string, signal?: AbortSignal): Promise<void> {
    if (this.pendingGate) {
      throw new Error(`${this.agent} bridge session has a permission gate awaiting the COO`)
    }
    if (this.state === 'stopped' || this.state === 'failed') {
      throw new Error(`Cannot steer a ${this.state} bridge session`)
    }
    this.state = 'running'
    try {
      await this.run(planBridgeSteer(this.acpSessionId, text), signal)
    } catch (error) {
      this.fail(error)
      throw error
    }
  }

  /** Parks an ACP permission request until the COO answers it; nothing is auto-approved. */
  askPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return new Promise((resolve) => {
      this.pendingGate = {
        toolCallId: request.toolCall.toolCallId,
        title: request.toolCall.title ?? request.toolCall.toolCallId,
        options: request.options.map((option) => ({
          optionId: option.optionId,
          name: option.name,
          kind: option.kind
        }))
      }
      this.state = 'awaiting_gate'
      this.gate = {
        settle: (allow) => {
          this.pendingGate = null
          this.gate = null
          if (this.state === 'awaiting_gate') {
            this.state = 'running'
          }
          resolve(bridgeGateAnswer(request, allow))
        }
      }
    })
  }

  /** Resolves the parked gate; false when the session is not awaiting one. */
  async answerGate(allow: boolean): Promise<boolean> {
    const gate = this.gate
    if (!gate) {
      return false
    }
    gate.settle(allow)
    return true
  }

  view(): BridgeSessionView {
    return {
      id: this.id,
      agent: this.agent,
      sessionId: this.acpSessionId,
      cwd: this.cwd,
      state: this.state,
      stopReason: this.stopReason,
      error: this.error,
      skipped: [...this.skipped],
      pendingGate: this.pendingGate
    }
  }

  /** Stops the child and drops bridge state for this session. */
  async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.gate?.settle(false)
    if (this.state === 'running' || this.state === 'awaiting_gate') {
      this.state = 'stopped'
    }
    if (!this.connection.exited) {
      await this.connection.close().catch(() => false)
    }
  }

  /** The plan is what gets sent, so its skipped list is the honest capability report. */
  private async run(plan: BridgePlan, signal?: AbortSignal): Promise<void> {
    this.skipped.push(...plan.skipped)
    const wait = <T>(call: Promise<T>): Promise<T> => waitForPromiseWithSignal(call, signal)
    for (const step of plan.steps) {
      switch (step.method) {
        case 'initialize':
          this.caps = readBridgeCapabilities(this.spec, await wait(this.connection.initialize()))
          break
        case 'authenticate':
          await wait(this.connection.authenticate(String(step.params.methodId)))
          break
        case 'session/new': {
          const started = await wait(
            this.connection.start({
              cwd: this.cwd,
              mcpServers: [],
              ...(this.authMethodId ? { authMethodId: this.authMethodId } : {}),
              ...(this.spec.authMethodUnavailableMessage
                ? { authMethodUnavailableMessage: this.spec.authMethodUnavailableMessage }
                : {})
            })
          )
          this.acpSessionId = started.sessionId
          noteBridgeSessionOffer(this.caps, started.response)
          break
        }
        case 'session/set_config_option':
          await wait(
            this.connection.setConfigOption(
              String(step.params.configId),
              step.params.value as string,
              undefined,
              undefined,
              BRIDGE_OPTION_TIMEOUT_MS
            )
          )
          break
        case 'session/set_model':
          await wait(
            this.connection.setModel(
              String(step.params.modelId),
              undefined,
              BRIDGE_OPTION_TIMEOUT_MS
            )
          )
          break
        case 'session/prompt':
          this.finishTurn(
            (await wait(this.connection.prompt(step.params.prompt as ContentBlock[]))).stopReason
          )
          break
      }
    }
  }

  private collect(event: AcpSessionEvent): void {
    if (event.kind !== 'known' || event.notification.sessionId !== this.acpSessionId) {
      return
    }
    const update = event.notification.update
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      this.text += update.content.text.slice(0, Math.max(0, BRIDGE_TEXT_LIMIT - this.text.length))
    }
  }

  private finishTurn(stopReason: string): void {
    this.stopReason = stopReason
    this.state = 'done'
  }

  private fail(error: unknown): void {
    this.state = 'failed'
    this.error = error instanceof Error ? error.message : String(error)
    this.gate?.settle(false)
  }
}

/** The offered option matching the COO's decision; no offer means the agent gets a cancel. */
function bridgeGateAnswer(
  request: RequestPermissionRequest,
  allow: boolean
): RequestPermissionResponse {
  const kinds = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
  for (const kind of kinds) {
    const option = request.options.find((candidate) => candidate.kind === kind)
    if (option) {
      return { outcome: { outcome: 'selected', optionId: option.optionId } }
    }
  }
  return { outcome: { outcome: 'cancelled' } }
}
