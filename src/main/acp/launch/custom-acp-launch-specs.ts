import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { GENERIC_ACP_DIALECT } from '../acp-dialects/acp-dialect'
import { directoryAccountBinding } from './acp-account-binding'
import type { StructuredAgentSessionHistory } from '../../native-chat/structured-agent-cli-conversations'
import type { AcpLaunchSpec } from './acp-launch-contract'

const CUSTOM_AGENTS_FILE = join(homedir(), '.orca', 'custom-agents.json')
const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,32}$/

type CustomAcpAgentEntry = {
  agent: string
  label?: string
  command: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  minimumVersions?: readonly string[]
}

// Chats cannot adopt an unknown CLI's terminal conversations, and claiming its history rows would
// need its binary in Orca's TUI catalog.
const CUSTOM_AGENT_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: [],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
}

function skip(index: number, reason: string): null {
  console.warn(`[acp] ignored custom agent entry ${index} in ${CUSTOM_AGENTS_FILE}: ${reason}`)
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalStringArray(value: unknown): string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((v) => typeof v === 'string'))
    ? (value as string[] | undefined)
    : undefined
}

function validateEntry(value: unknown, index: number): CustomAcpAgentEntry | null {
  if (!isRecord(value)) {
    return skip(index, 'expected an object')
  }
  const { agent, label, command, args, env, minimumVersions } = value
  if (typeof agent !== 'string' || !AGENT_ID_PATTERN.test(agent)) {
    return skip(index, `agent must match ${AGENT_ID_PATTERN}`)
  }
  if (label !== undefined && typeof label !== 'string') {
    return skip(index, `${agent} has a non-string label`)
  }
  if (typeof command !== 'string' || command.length === 0) {
    return skip(index, `${agent} needs a command`)
  }
  const entryArgs = optionalStringArray(args)
  if (!entryArgs && args !== undefined) {
    return skip(index, `${agent} has non-string args`)
  }
  let parsedEnv: Record<string, string> | undefined
  if (env !== undefined) {
    if (!isRecord(env) || !Object.values(env).every((value) => typeof value === 'string')) {
      return skip(index, `${agent} has an env that is not a string-to-string map`)
    }
    parsedEnv = env as Record<string, string>
  }
  const versions = optionalStringArray(minimumVersions)
  if (!versions && minimumVersions !== undefined) {
    return skip(index, `${agent} has non-string minimumVersions`)
  }
  return {
    agent,
    ...(label !== undefined ? { label } : {}),
    command,
    ...(entryArgs ? { args: entryArgs } : {}),
    ...(parsedEnv ? { env: parsedEnv } : {}),
    ...(versions && versions.length > 0 ? { minimumVersions: versions } : {})
  }
}

function customLaunchSpec(entry: CustomAcpAgentEntry): AcpLaunchSpec {
  // Why a namespaced variable: an unknown CLI's own config-directory convention is not known, and
  // setting `<ID>_HOME` would hide the sign-in the user already has.
  const variable = `ORCA_CUSTOM_AGENT_${entry.agent.toUpperCase().replace(/-/g, '_')}_HOME`
  const { args, env, minimumVersions } = entry
  return {
    agent: entry.agent as AcpLaunchSpec['agent'],
    command: entry.command,
    args: () => [...(args ?? [])],
    env: env ?? {},
    dialect: GENERIC_ACP_DIALECT,
    loginCommand: [],
    account: directoryAccountBinding(variable, (homePath) =>
      join(homePath, '.orca', 'custom-agents', entry.agent)
    ),
    installDirectories: () => [],
    ...(minimumVersions ? { minimumVersions } : {}),
    // Only a live session can list what an unknown agent allows.
    modelDiscovery: {
      kind: 'unavailable',
      reason: `${entry.agent} lists models only in its chats`
    },
    transcriptImport: null,
    sessionHistory: CUSTOM_AGENT_SESSION_HISTORY
  }
}

export function loadCustomAcpLaunchSpecs(): AcpLaunchSpec[] {
  let raw: string
  try {
    raw = readFileSync(CUSTOM_AGENTS_FILE, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.warn(`[acp] ${CUSTOM_AGENTS_FILE} is not valid JSON:`, error)
    return []
  }
  if (!Array.isArray(parsed)) {
    console.warn(`[acp] ${CUSTOM_AGENTS_FILE} must hold a JSON array of agent entries.`)
    return []
  }
  const specs: AcpLaunchSpec[] = []
  const seen = new Set<string>()
  parsed.forEach((value, index) => {
    const entry = validateEntry(value, index)
    if (!entry) {
      return
    }
    if (seen.has(entry.agent)) {
      skip(index, `${entry.agent} is already declared earlier in the file`)
      return
    }
    seen.add(entry.agent)
    specs.push(customLaunchSpec(entry))
  })
  return specs
}
