import { describe, expect, it } from 'vitest'
import { buildBridgeAcpLaunch } from './orca-bridge-acp-adapter'
import type { BridgeCard } from './orca-bridge-card-plan'

const PINNED = 'opus-4.5-high'

function card(over: Partial<BridgeCard> = {}): BridgeCard {
  return {
    id: 'CARD-1',
    title: 'Pin a model',
    body: 'Do the work.',
    assignee: 'omp',
    cwd: '/execution-host/folder',
    attachments: [],
    metadata: {},
    ...over
  }
}

function argAfter(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}

describe('bridge launch model pin', () => {
  it('launches a --model= spec on the pinned model', async () => {
    const launch = await buildBridgeAcpLaunch(card({ model: PINNED }))
    expect(argAfter(launch.args, '--model')).toBe(PINNED)
  })

  it('omits the flag when the card names no model', async () => {
    const launch = await buildBridgeAcpLaunch(card())
    expect(launch.args).not.toContain('--model')
  })
})
