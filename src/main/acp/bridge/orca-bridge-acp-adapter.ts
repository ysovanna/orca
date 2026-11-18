// Dispatches kanban cards over ACP children of any agent with a launch spec, sending only the
// native messages that agent advertised and keeping the child open so the bridge can read it back.

import { homedir } from 'node:os'
import { ACP_LAUNCH_SPECS, acpLaunchSpecFor } from '../launch/acp-launch-registry'
import {
  acpLaunchSpecForAccount,
  resolveAcpLaunchCommand,
  selectAcpHostAccountHome
} from '../launch/acp-launch-command'
import { createAcpAgentConnection } from '../process/acp-agent-connection'
import type { ConnectAcpAgent } from '../process/acp-structured-connection'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import type { AcpHostBackendSettings, AcpLaunchSpec } from '../launch/acp-launch-contract'
import {
  resolveHostStructuredAgentLaunchEnvironment,
  type LaunchEnvironmentSettings
} from '../../runtime/agent-session/launch/structured-agent-launch-support'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
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
  /** Host-backend selection input; the daemon has no settings store, so absent reads as app defaults. */
  hostBackendSettings?: AcpHostBackendSettings
}

/** What a card runs: the launch line and the spec (agent's own or host backend) it came from. */
export type BridgeAcpLaunch = ProviderProcessLaunch & { spec: AcpLaunchSpec }

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
    const task = { ...card, cwd: card.cwd ?? homedir() }
    const launch = await buildBridgeAcpLaunch(task, this.deps)
    const spec = launch.spec
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
}

/** The card's launch line, resolved the way a chat's is; spawns nothing. */
export async function buildBridgeAcpLaunch(
  card: BridgeCard,
  deps: OrcaBridgeAcpAdapterDeps = {}
): Promise<BridgeAcpLaunch> {
  const rawSpec = acpLaunchSpecFor(card.assignee)
  if (!rawSpec) {
    throw new Error(`No ACP launch spec for kanban assignee "${card.assignee}"`)
  }
  // A compatible host program pins the chat's account home, so its spec owns account and command.
  const spec = (await bridgeHostBackendSpec(rawSpec, deps)) ?? rawSpec
  const env = { ...(deps.environment?.() ?? readBaseEnvironment()) }
  const home = await spec.account.resolve({
    launchEnv: process.env,
    stateDirectory: deps.stateDirectory ?? ''
  })
  Object.assign(env, spec.account.environment(home, env))
  const envToDelete = spec.scrubEnvironment?.(env, process.env) ?? []
  Object.assign(env, spec.env)
  const homePath = env.HOME ?? env.USERPROFILE ?? homedir()
  const { command, prefixArgs } = resolveAcpLaunchCommand(spec, env, {
    homePath,
    dataDirectory: deps.dataDirectory ?? null
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
    envToDelete,
    spec
  }
}

/** The host backend's spec when its program signs in for sessions on this host, else null. */
async function bridgeHostBackendSpec(
  spec: AcpLaunchSpec,
  deps: OrcaBridgeAcpAdapterDeps
): Promise<AcpLaunchSpec | null> {
  if (!spec.hostBackend) {
    return null
  }
  const settings = (deps.hostBackendSettings ?? {}) as LaunchEnvironmentSettings
  try {
    const home = await selectAcpHostAccountHome(
      spec,
      await resolveHostStructuredAgentLaunchEnvironment(spec.agent, settings),
      // Lazily: importing this module must not require an installed AppEnvironment.
      deps.stateDirectory || getProfileUserDataPath(),
      settings
    )
    return home ? acpLaunchSpecForAccount(spec, home) : null
  } catch {
    return null
  }
}

function readBaseEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}
