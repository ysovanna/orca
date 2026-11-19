import { beforeEach, describe, expect, it, vi } from 'vitest'

type Captured = { status: number; body: Record<string, unknown> }
type Route = { method: string; path: string; handler: (ctx: unknown) => Promise<void> | void }

const routes = new Map<string, Route>()
const opened: Record<string, unknown>[] = []

vi.mock('../../daemon/endpoint/http-gateway', () => ({
  registerBridgeRoute: (route: Route) => {
    routes.set(`${route.method} ${route.path}`, route)
    return () => {}
  },
  sendBridgeJson: (res: { captured?: Captured[] }, status: number, body: unknown) => {
    ;(res.captured ??= []).push({ status, body: body as Record<string, unknown> })
  }
}))

vi.mock('./orca-bridge-acp-adapter', () => ({
  OrcaBridgeAcpAdapter: class {
    async open(card: Record<string, unknown>) {
      opened.push(card)
      const model = typeof card.model === 'string' ? card.model : null
      return {
        id: `session-${opened.length}`,
        text: '',
        pendingGate: null,
        view: () => ({ id: `session-${opened.length}`, agent: card.assignee, model }),
        runCard: async () => {},
        steer: async () => {},
        answerGate: async () => false,
        stop: async () => {}
      }
    }
  }
}))

const { registerOrcaBridgeRoutes } = await import('./orca-bridge-sessions')

function request(body: unknown) {
  return Object.assign(
    (async function* generate() {
      yield Buffer.from(JSON.stringify(body))
    })(),
    { method: 'POST', url: '/v1/sessions', headers: {} }
  )
}

async function postSessions(body: unknown): Promise<Captured[]> {
  registerOrcaBridgeRoutes()
  const res = { captured: [] as Captured[] }
  await routes.get('POST /v1/sessions')!.handler({ req: request(body), res, params: {} })
  return res.captured
}

const BASE_CARD = { id: 'CARD-1', title: 'Work', body: 'Do it.', assignee: 'omp' }

describe('POST /v1/sessions model pin', () => {
  beforeEach(() => {
    routes.clear()
    opened.length = 0
  })

  it('carries an omitted model as no pin at all', async () => {
    const sent = await postSessions(BASE_CARD)
    expect(sent[0]?.status).toBe(202)
    expect(opened[0]).not.toHaveProperty('model')
    expect(sent[0]?.body.session).toMatchObject({ model: null })
  })

  it('passes a pinned model to the session layer and reads it back', async () => {
    const sent = await postSessions({ ...BASE_CARD, model: 'gemini-4-neon-high' })
    expect(sent[0]?.status).toBe(202)
    expect(opened[0]).toMatchObject({ model: 'gemini-4-neon-high' })
    expect(sent[0]?.body.session).toMatchObject({ model: 'gemini-4-neon-high' })
  })

  it('rejects a pinned model for an agent whose model discovery is unavailable', async () => {
    const sent = await postSessions({ ...BASE_CARD, assignee: 'antigravity', model: 'gpt-some' })
    expect(sent[0]).toMatchObject({ status: 400, body: { error: 'invalid_request' } })
    expect(opened).toHaveLength(0)
  })

  it('rejects an empty model the same way as any malformed field', async () => {
    const sent = await postSessions({ ...BASE_CARD, model: '' })
    expect(sent[0]?.status).toBe(400)
    expect(opened).toHaveLength(0)
  })
})
