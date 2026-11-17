// Dispatches kanban cards over ACP children of any agent with a launch spec, sending only the
// native messages that agent advertised and keeping the child open so the bridge can read it back.

import { homedir } from 'node:os'
import { ACP_LAUNCH_SPECS, acpLaunchSpecFor } from '../launch/acp-launch-registry'
import { resolveAcpLaunchCommand } from '../launch/acp-launch-command'
import { createAcpAgentConnection } from '../process/acp-agent-connection'
import type { ConnectAcpAgent } from '../process/acp-structured-connection'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { BridgeAcpSession } from './orca-bridge-acp-session'
import type { BridgeCard } from './orca-bridge-card-plan'

export { BridgeAcpSession } from './orca-bridge-acp-session'
export type {
  BridgeGateRequest,
  BridgeSessionState,
  BridgeSessionView
} from './orca-bridge-session-view'
export {
  bridgeCardPromptText,
  buildBridgePrompt,
  parseBridgeCard,
  planBridgeStart,
  planBridgeTurn,
  readBridgeCapabilities,
  type BridgeAgentCapabilities,
  type BridgeCard,
  type BridgeCardAttachment,
  type BridgeCardParse,
  type BridgePlan
} from './orca-bridge-card-plan'

export type BridgeCardResult = {
  agent: string
  sessionId: string
  text: string
  stopReason: string | null
  /** Everything the card asked for that this agent could not carry. */
  skipped: string[]
}

export type OrcaBridgeAcpAdapterDeps = {
  connect?: ConnectAcpAgent
  /** Overlay for the agent process; defaults to this process's environment. */
  environment?: () => Record<string, string>
  stateDirectory?: string
  dataDirectory?: string | null
}

/** Agents the bridge can take as a kanban assignee without further code. */
export function bridgeAssignableAgents(): string[] {
  return ACP_LAUNCH_SPECS.map((spec) => spec.agent)
}

/** The sign-in the launch environment actually carries; null leaves the agent's own choice. */
function bridgeAuthMethodId(spec: AcpLaunchSpec, env: Record<string, string>): string | null {
  return spec.authMethod?.({ advertised: [], env }) ?? null
}

export class OrcaBridgeAcpAdapter {
  private readonly connect: ConnectAcpAgent

  constructor(private readonly deps: OrcaBridgeAcpAdapterDeps = {}) {
    this.connect = deps.connect ?? createAcpAgentConnection
  }

  /** Launches the assignee and starts its ACP session; throws when it has no launch spec. */
  async open(card: BridgeCard, signal?: AbortSignal): Promise<BridgeAcpSession> {
    const spec = acpLaunchSpecFor(card.assignee)
    if (!spec) {
      throw new Error(`No ACP launch spec for kanban assignee "${card.assignee}"`)
    }
    const task = { ...card, cwd: card.cwd ?? homedir() }
    const launch = await this.launchFor(spec, task)
    const authMethodId = bridgeAuthMethodId(spec, launch.env ?? {})
    const session = new BridgeAcpSession(
      spec,
      task,
      authMethodId,
      this.connect(launch, {
        clientInfo: { name: 'orca-bridge', version: '1' },
        // The bridge has no human at the keyboard: every permission request becomes a COO gate.
        onPermission: (request) => session.askPermission(request),
        onRequest: (method) => {
          throw new Error(`${spec.agent} sent an unsupported ACP request: ${method}`)
        }
      })
    )
    try {
      await session.start(signal)
    } catch (error) {
      await session.stop().catch(() => false)
      throw error
    }
    return session
  }

  /** One-shot card run for callers that only want the finished reply. */
  async dispatch(card: BridgeCard, signal?: AbortSignal): Promise<BridgeCardResult> {
    const session = await this.open(card, signal)
    try {
      await session.runCard(signal)
    } finally {
      await session.stop()
    }
    const view = session.view()
    return {
      agent: view.agent,
      sessionId: view.sessionId,
      text: session.text,
      stopReason: view.stopReason,
      skipped: view.skipped
    }
  }

  /** The agent's own launch line, built from its spec the way a chat's would be. */
  private async launchFor(spec: AcpLaunchSpec, card: BridgeCard): Promise<ProviderProcessLaunch> {
    const env = { ...(this.deps.environment?.() ?? readBaseEnvironment()) }
    const home = await spec.account.resolve({
      launchEnv: process.env,
      stateDirectory: this.deps.stateDirectory ?? ''
    })
    Object.assign(env, spec.account.environment(home, env))
    const envToDelete = spec.scrubEnvironment?.(env, process.env) ?? []
    Object.assign(env, spec.env)
    const homePath = env.HOME ?? env.USERPROFILE ?? homedir()
    const { command, prefixArgs } = resolveAcpLaunchCommand(spec, env, {
      homePath,
      dataDirectory: this.deps.dataDirectory ?? null
    })
    return {
      command,
      args: [
        ...prefixArgs,
        ...spec.args({
          fullAccess: card.permissionMode === 'full-access',
          pluginDir: null,
          ...(card.model && spec.launchesWithModel ? { model: card.model } : {})
        })
      ],
      cwd: card.cwd ?? homePath,
      env,
      envToDelete
    }
  }
}

function readBaseEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}
