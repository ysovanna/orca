import { describe, expect, it, vi } from 'vitest'
import { BridgeAcpSession } from './orca-bridge-acp-session'
import type { AcpStructuredConnection } from '../process/acp-structured-connection'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import type { BridgeCard } from './orca-bridge-card-plan'

const PINNED = 'gemini-3.8-flash-low'

function card(over: Partial<BridgeCard> = {}): BridgeCard {
  return {
    id: 'CARD-1',
    title: 'Pin a model',
    body: 'Do the work.',
    assignee: 'hermes',
    cwd: '/execution-host/folder',
    attachments: [],
    metadata: {},
    ...over
  }
}

function fakeConnection(availableModels: string[]) {
  const setModel = vi.fn(async () => ({}))
  const start = vi.fn(async () => ({
    sessionId: 'native-1',
    response: availableModels.length
      ? { models: { availableModels: availableModels.map((modelId) => ({ modelId })) } }
      : {}
  }))
  const prompt = vi.fn(async () => ({ stopReason: 'end_turn' as const }))
  const connection = {
    exited: false,
    subscribe: () => () => {},
    initialize: async () => ({}),
    authenticate: async () => {},
    start,
    setModel,
    prompt,
    close: async () => {}
  }
  return {
    connection: connection as unknown as AcpStructuredConnection,
    calls: () => ({ setModel, start, prompt })
  }
}

function harness(spec: Partial<AcpLaunchSpec>, bridgeCard: BridgeCard) {
  const fake = fakeConnection(['gemini-4-neon-high', PINNED])
  return {
    ...fake,
    session: new BridgeAcpSession(
      { agent: 'hermes', launchesWithModel: undefined, ...spec } as AcpLaunchSpec,
      bridgeCard,
      null,
      fake.connection
    )
  }
}

describe('bridge session model pin', () => {
  it('sends session/set_model with the pinned model and reads it back', async () => {
    const { session, calls } = harness({}, card({ model: PINNED }))
    await session.start()
    expect(calls().start.mock.calls.length).toBe(1)
    await session.runCard()
    expect(calls().setModel).toHaveBeenCalledWith(PINNED, undefined, 30_000)
    // The pin is applied after session/new and before the card's prompt.
    const { start, setModel, prompt } = calls()
    const order = [
      start.mock.invocationCallOrder[0],
      setModel.mock.invocationCallOrder[0],
      prompt.mock.invocationCallOrder[0]
    ]

    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(session.view().model).toBe(PINNED)
  })

  it('leaves the agent default when the card names no model', async () => {
    const { session, calls } = harness({}, card())
    await session.start()
    await session.runCard()
    expect(calls().setModel).not.toHaveBeenCalled()
    expect(session.view().model).toBeNull()
  })

  it('reports the launch-line model for a spec that launches with one', () => {
    const { session } = harness({ launchesWithModel: true }, card({ model: PINNED }))
    // OMP-style specs get --model= at spawn, before any ACP call.
    expect(session.view().model).toBe(PINNED)
  })
})
