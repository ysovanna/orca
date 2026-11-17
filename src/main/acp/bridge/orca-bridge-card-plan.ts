// Kanban card to native ACP stdio messages, narrowed to what one agent build advertises.

import { z } from 'zod'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import type { AgentChatPermissionMode } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type {
  ContentBlock,
  InitializeResponse,
  SessionConfigOption
} from '../generated/acp-protocol.generated'

export const BRIDGE_TEXT_LIMIT = 200_000

/** Config option id most agents name their permission mode with. */
const BRIDGE_MODE_OPTION = 'mode'

/** One kanban card as the bridge receives it; only id/title/body/assignee are required. */
export type BridgeCard = {
  id: string
  title: string
  body: string
  /** Registry agent name, e.g. `grok`, `opencode`, `hermes-orchestrator`. */
  assignee: string
  cwd?: string
  model?: string
  permissionMode?: AgentChatPermissionMode
  attachments: BridgeCardAttachment[]
  /** Free-form COO metadata (provider, parents); carried into the prompt as context lines. */
  metadata: Record<string, string>
}

export type BridgeCardAttachment = {
  name?: string
  path?: string
  mimeType?: string
  /** Base64 payload; only sent inline when the agent advertises that content type. */
  data?: string
}

const attachmentSchema = z.looseObject({
  name: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  data: z.string().min(1).optional()
})

const cardSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  assignee: z.string().min(1),
  cwd: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  permissionMode: z.enum(['ask', 'accept-edits', 'auto', 'full-access']).optional(),
  attachments: z.array(attachmentSchema).optional(),
  metadata: z.record(z.string(), z.string()).optional()
})

export type BridgeCardParse = { ok: true; card: BridgeCard } | { ok: false; error: string }

/** Rejects malformed cards before any child is spawned. */
export function parseBridgeCard(input: unknown): BridgeCardParse {
  const parsed = cardSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Malformed kanban card' }
  }
  const card = parsed.data
  return {
    ok: true,
    card: {
      id: card.id,
      title: card.title,
      body: card.body,
      assignee: card.assignee,
      ...(card.cwd ? { cwd: card.cwd } : {}),
      ...(card.model ? { model: card.model } : {}),
      ...(card.permissionMode ? { permissionMode: card.permissionMode } : {}),
      attachments: card.attachments ?? [],
      metadata: card.metadata ?? {}
    }
  }
}

/** What one agent build actually accepts, read from its launch spec plus `initialize`. */
export type BridgeAgentCapabilities = {
  agent: string
  image: boolean
  audio: boolean
  embeddedContext: boolean
  resumeSession: boolean
  /** Orca's permission modes this agent can run in, and the session option that carries them. */
  permissionValues: Partial<Record<AgentChatPermissionMode, string>>
  modeOptionId: string | null
  modelIds: string[]
}

export function readBridgeCapabilities(
  spec: AcpLaunchSpec,
  initialized: Partial<InitializeResponse>
): BridgeAgentCapabilities {
  const prompt = initialized.agentCapabilities?.promptCapabilities
  return {
    agent: spec.agent,
    image: prompt?.image === true,
    audio: prompt?.audio === true,
    embeddedContext: prompt?.embeddedContext === true,
    resumeSession: initialized.agentCapabilities?.sessionCapabilities?.resume != null,
    permissionValues: spec.permissionModeConfig?.values ?? {},
    modeOptionId: null,
    modelIds: []
  }
}

/** Narrows the profile with what the started session offered; absent means "no way to set it". */
export function noteBridgeSessionOffer(
  caps: BridgeAgentCapabilities,
  started: {
    configOptions?: (SessionConfigOption | null)[] | null
    models?: { availableModels?: { modelId: string }[] | null } | null
  }
): BridgeAgentCapabilities {
  const options = (started.configOptions ?? []).filter(
    (option): option is SessionConfigOption => option != null
  )
  caps.modeOptionId =
    options.find((option) => option.category === 'mode')?.id ??
    (options.some((option) => option.id === BRIDGE_MODE_OPTION) ? BRIDGE_MODE_OPTION : null)
  caps.modelIds = (started.models?.availableModels ?? []).map((model) => model.modelId)
  return caps
}

/** Card header the agent sees before its task text; metadata carries the COO's provider choice. */
export function bridgeCardPromptText(card: BridgeCard): string {
  const context = Object.entries(card.metadata).map(([key, value]) => `- ${key}: ${value}`)
  return [
    `Kanban card ${card.id}: ${card.title}`,
    ...(context.length ? ['Context:', ...context] : []),
    '',
    card.body
  ].join('\n')
}

/** Attachment blocks the agent can read; what it never advertised degrades to a path note. */
function attachmentBlocks(
  attachments: BridgeCardAttachment[],
  caps: BridgeAgentCapabilities,
  skipped: string[]
): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const attachment of attachments) {
    const label = attachment.name ?? attachment.path ?? 'attachment'
    const mime = attachment.mimeType ?? ''
    if (attachment.data && mime.startsWith('image/') && caps.image) {
      blocks.push({ type: 'image', data: attachment.data, mimeType: mime })
      continue
    }
    if (attachment.data && mime.startsWith('audio/') && caps.audio) {
      blocks.push({ type: 'audio', data: attachment.data, mimeType: mime })
      continue
    }
    if (attachment.path && caps.embeddedContext) {
      blocks.push({
        type: 'resource_link',
        name: label,
        uri: attachment.path,
        ...(mime ? { mimeType: mime } : {})
      })
      continue
    }
    skipped.push(`${label}: no advertised content channel`)
    if (attachment.path) {
      blocks.push({
        type: 'text',
        text: `Attachment not attached (this agent cannot receive it): ${attachment.path}`
      })
    }
  }
  return blocks
}

export type BridgePrompt = { prompt: ContentBlock[]; skipped: string[] }

/** The `session/prompt` content for a card, degraded to what this agent accepts. */
export function buildBridgePrompt(card: BridgeCard, caps: BridgeAgentCapabilities): BridgePrompt {
  const skipped: string[] = []
  const text = bridgeCardPromptText(card)
  const prompt: ContentBlock[] = [
    { type: 'text', text: text.slice(0, BRIDGE_TEXT_LIMIT) },
    ...attachmentBlocks(card.attachments, caps, skipped)
  ]
  if (text.length > BRIDGE_TEXT_LIMIT) {
    skipped.push('card body truncated to the bridge text limit')
  }
  return { prompt, skipped }
}

/** ACP stdio methods the bridge is willing to send for one card. */
export type BridgeStepMethod =
  | 'initialize'
  | 'authenticate'
  | 'session/new'
  | 'session/set_config_option'
  | 'session/set_model'
  | 'session/prompt'

export type BridgePlan = {
  steps: { method: BridgeStepMethod; params: Record<string, unknown> }[]
  /** Card content or settings this agent build cannot carry. */
  skipped: string[]
}

/** Startup half of the plan; `authMethodId` is null when the launch environment carries no sign-in. */
export function planBridgeStart(card: BridgeCard, authMethodId: string | null): BridgePlan {
  const steps: BridgePlan['steps'] = [{ method: 'initialize', params: {} }]
  if (authMethodId) {
    steps.push({ method: 'authenticate', params: { methodId: authMethodId } })
  }
  steps.push({ method: 'session/new', params: { cwd: card.cwd ?? '', mcpServers: [] } })
  return { steps, skipped: [] }
}

/** Turn half of the plan; every unsupported message is dropped with a reason instead of failing. */
export function planBridgeTurn(
  card: BridgeCard,
  caps: BridgeAgentCapabilities,
  sessionId: string
): BridgePlan {
  const steps: BridgePlan['steps'] = []
  const skipped: string[] = []
  const mode = card.permissionMode
  if (mode) {
    const value = caps.permissionValues[mode]
    if (value && caps.modeOptionId) {
      steps.push({
        method: 'session/set_config_option',
        params: { configId: caps.modeOptionId, value }
      })
    } else {
      skipped.push(
        `permission mode ${mode}: ${caps.modeOptionId ? 'the agent has no value for it' : 'the session offers no mode option'}`
      )
    }
  }
  if (card.model) {
    // An advertised list is the only proof the id names a model; otherwise leave the agent default.
    if (caps.modelIds.length === 0 || caps.modelIds.includes(card.model)) {
      steps.push({ method: 'session/set_model', params: { modelId: card.model } })
    } else {
      skipped.push(`model ${card.model} is not in this session's list`)
    }
  }
  const prompt = buildBridgePrompt(card, caps)
  steps.push({ method: 'session/prompt', params: { sessionId, prompt: prompt.prompt } })
  return { steps, skipped: [...skipped, ...prompt.skipped] }
}

/** COO steering text as one more prompt turn; attachments are a card-only concept. */
export function planBridgeSteer(sessionId: string, text: string): BridgePlan {
  return {
    steps: [
      {
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [{ type: 'text', text: text.slice(0, BRIDGE_TEXT_LIMIT) } satisfies ContentBlock]
        }
      }
    ],
    skipped:
      text.length > BRIDGE_TEXT_LIMIT ? ['steer text truncated to the bridge text limit'] : []
  }
}
