// Bridge session registry and the /v1 routes that let an external COO dispatch, steer and gate cards.

import { delimiter } from 'node:path'
import { homedir } from 'node:os'
import { registerBridgeRoute, sendBridgeJson } from '../../daemon/endpoint/http-gateway'
import { ACP_LAUNCH_SPECS, acpLaunchSpecFor } from '../launch/acp-launch-registry'
import { resolveExecutableCommand } from '../../../shared/node-cli-command-resolution'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import {
  OrcaBridgeAcpAdapter,
  type BridgeAcpSession,
  type BridgeCard
} from './orca-bridge-acp-adapter'
import { parseBridgeCard } from './orca-bridge-card-plan'
import { readJsonBody, textField, badRequest, notFound } from './orca-bridge-request-body'

export type BridgeAgentEntry = {
  agent: string
  /** The launch line resolves to a program on this host. */
  available: boolean
  command: string
  permissionModes: string[]
  /** Model ids only exist once a session advertises them; the catalog names the discovery kind. */
  modelDiscovery: string
}

function bridgeAgentEntry(spec: AcpLaunchSpec): BridgeAgentEntry {
  const env = { ...process.env } as Record<string, string>
  const homePath = env.HOME ?? env.USERPROFILE ?? homedir()
  const pathEnv = [env.PATH ?? env.Path, ...spec.installDirectories({ env, homePath })]
    .filter(Boolean)
    .join(delimiter)
  const command = resolveExecutableCommand(spec.command, { pathEnv, homePath })
  return {
    agent: spec.agent,
    available: command !== null || spec.managedRuntime != null,
    command: command ?? spec.command,
    permissionModes: Object.keys(spec.permissionModeConfig?.values ?? {}),
    modelDiscovery: spec.modelDiscovery.kind
  }
}

const sessions = new Map<string, BridgeAcpSession>()
const adapter = new OrcaBridgeAcpAdapter()

function sessionOf(id: string): BridgeAcpSession | null {
  return sessions.get(id) ?? null
}

/** Registers the bridge route bodies on the existing gateway; returns the unregister closure. */
export function registerOrcaBridgeRoutes(): () => void {
  const unregister = [
    registerBridgeRoute({
      method: 'GET',
      path: '/v1/agents',
      handler: ({ res }) => {
        sendBridgeJson(res, 200, { agents: ACP_LAUNCH_SPECS.map(bridgeAgentEntry) })
      }
    }),
    registerBridgeRoute({
      method: 'GET',
      path: '/v1/agents/:agent',
      handler: ({ res, params }) => {
        const spec = acpLaunchSpecFor(params.agent)
        if (!spec) {
          notFound(res, params.agent)
          return
        }
        const agent = bridgeAgentEntry(spec)
        if (!agent.available) {
          sendBridgeJson(res, 503, {
            error: 'agent_unavailable',
            message: `${agent.agent} is not installed on this host`
          })
          return
        }
        sendBridgeJson(res, 200, { agent })
      }
    }),
    registerBridgeRoute({
      method: 'POST',
      path: '/v1/sessions',
      handler: async ({ req, res }) => {
        let card: BridgeCard
        try {
          const parsed = parseBridgeCard(await readJsonBody(req))
          if (!parsed.ok) {
            sendBridgeJson(res, 400, { error: 'invalid_request', message: parsed.error })
            return
          }
          card = parsed.card
        } catch (error) {
          badRequest(res, error)
          return
        }
        if (!acpLaunchSpecFor(card.assignee)) {
          sendBridgeJson(res, 503, {
            error: 'agent_unavailable',
            message: `no ACP launch spec for assignee "${card.assignee}"`
          })
          return
        }
        let session: BridgeAcpSession
        try {
          session = await adapter.open(card)
        } catch (error) {
          sendBridgeJson(res, 503, { error: 'agent_unavailable', message: String(error) })
          return
        }
        sessions.set(session.id, session)
        // Dispatch is asynchronous: the reply is read back from GET /v1/sessions/:id.
        void session.runCard().catch(() => false)
        sendBridgeJson(res, 202, { session: session.view() })
      }
    }),
    registerBridgeRoute({
      method: 'GET',
      path: '/v1/sessions',
      handler: ({ res }) => {
        sendBridgeJson(res, 200, { sessions: [...sessions.values()].map((s) => s.view()) })
      }
    }),
    registerBridgeRoute({
      method: 'GET',
      path: '/v1/sessions/:id',
      handler: ({ res, params }) => {
        const session = sessionOf(params.id)
        if (!session) {
          notFound(res, params.id)
          return
        }
        sendBridgeJson(res, 200, { session: session.view(), text: session.text })
      }
    }),
    registerBridgeRoute({
      method: 'POST',
      path: '/v1/sessions/:id/steer',
      handler: async ({ req, res, params }) => {
        const session = sessionOf(params.id)
        if (!session) {
          notFound(res, params.id)
          return
        }
        if (session.pendingGate) {
          sendBridgeJson(res, 409, { error: 'gate_pending', gate: session.pendingGate })
          return
        }
        let prompt: string
        try {
          prompt = textField(await readJsonBody(req), 'prompt')
        } catch (error) {
          badRequest(res, error)
          return
        }
        void session.steer(prompt).catch(() => false)
        sendBridgeJson(res, 202, { accepted: true })
      }
    }),
    registerBridgeRoute({
      method: 'POST',
      path: '/v1/sessions/:id/gate',
      handler: async ({ req, res, params }) => {
        const session = sessionOf(params.id)
        if (!session) {
          notFound(res, params.id)
          return
        }
        let decision: string
        try {
          decision = textField(await readJsonBody(req), 'decision')
        } catch (error) {
          badRequest(res, error)
          return
        }
        if (decision !== 'allow' && decision !== 'deny') {
          badRequest(res, new Error('decision must be allow or deny'))
          return
        }
        if (!(await session.answerGate(decision === 'allow'))) {
          sendBridgeJson(res, 409, { error: 'no_gate_pending' })
          return
        }
        sendBridgeJson(res, 202, { resolved: decision })
      }
    }),
    registerBridgeRoute({
      method: 'GET',
      path: '/v1/sessions/:id/gate',
      handler: ({ res, params }) => {
        const session = sessionOf(params.id)
        if (!session) {
          notFound(res, params.id)
          return
        }
        sendBridgeJson(res, 200, { pending: session.pendingGate })
      }
    }),
    registerBridgeRoute({
      method: 'DELETE',
      path: '/v1/sessions/:id',
      handler: async ({ res, params }) => {
        const session = sessionOf(params.id)
        if (!session) {
          notFound(res, params.id)
          return
        }
        sessions.delete(params.id)
        await session.stop()
        sendBridgeJson(res, 202, { stopped: true })
      }
    })
  ]
  return () => {
    for (const off of unregister) {
      off()
    }
  }
}
