import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { GENERIC_ACP_DIALECT } from '../acp/acp-dialects/acp-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/agent-session-setup-commands'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Chats and terminals share Hermes' session store under ~/.hermes.
const HERMES_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['hermes'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['--continue'],
      markers: ['-r', '--resume']
    })
}

// A Hermes profile is chosen with `-p <profile>`, which re-homes HERMES_HOME to that profile's store.
function hermesLaunchSpec(agent: AcpLaunchSpec['agent'], profile?: string): AcpLaunchSpec {
  return {
    agent,
    command: 'hermes',
    args: () => (profile ? ['-p', profile, 'acp'] : ['acp']),
    env: {},
    dialect: GENERIC_ACP_DIALECT,
    loginCommand: agentSessionSetupFor('hermes')?.loginCommand ?? [],
    account: directoryAccountBinding('HERMES_HOME', (homePath) => join(homePath, '.hermes')),
    installDirectories: () => [],
    // Only a session lists the models its account allows.
    modelDiscovery: { kind: 'session', listingNamesConfiguredModel: false },
    transcriptImport: null,
    sessionHistory: HERMES_SESSION_HISTORY
  }
}

export const HERMES_LAUNCH_SPEC = hermesLaunchSpec('hermes')
export const HERMES_ORCHESTRATOR_LAUNCH_SPEC = hermesLaunchSpec(
  'hermes-orchestrator',
  'orchestrator'
)
export const HERMES_RESEARCH_LAUNCH_SPEC = hermesLaunchSpec('hermes-research', 'research')
export const HERMES_FINANCE_FUND_MANAGER_LAUNCH_SPEC = hermesLaunchSpec(
  'hermes-finance-fund-manager',
  'finance-fund-manager'
)
export const HERMES_QA_SECURITY_LAUNCH_SPEC = hermesLaunchSpec('hermes-qa-security', 'qa-security')
