// Run-proxy bridge routes: /v1/runs* forwards to the same orchestration RPCs the CLI handlers call.

import type { ServerResponse } from 'node:http'
import { registerBridgeRoute, sendBridgeJson } from '../../daemon/endpoint/http-gateway'
import { readJsonBody, textField, badRequest } from './orca-bridge-request-body'

/** Reaches the main-process runtime; the CLI's RuntimeClient is the production implementation. */
export type RunProxyServices = {
  call<TResult>(method: string, params: unknown): Promise<TResult>
}

export type BridgeRunEvent = {
  seq: number
  kind: 'task' | 'gate' | 'message'
  id: string
  status: string
  data: Record<string, unknown>
}

type RunLedger = { seen: Set<string>; events: BridgeRunEvent[] }

const MAX_LEDGER_EVENTS = 1_000
const ledgers = new Map<string, RunLedger>()

function ledgerOf(runId: string): RunLedger {
  const existing = ledgers.get(runId)
  if (existing) {
    return existing
  }
  // A run's event stream only exists once a caller watches it through this bridge.
  const created: RunLedger = { seen: new Set<string>(), events: [] }
  ledgers.set(runId, created)
  return created
}

function rowString(row: Record<string, unknown>, name: string): string {
  const value = row[name]
  return typeof value === 'string' ? value : ''
}

/** A row's identity plus its mutable state, so a status change is a new event. */
function fingerprint(kind: BridgeRunEvent['kind'], row: Record<string, unknown>): string {
  const id = rowString(row, 'id')
  const status = rowString(row, 'status') || rowString(row, 'state')
  return `${kind}:${id}:${status}:${rowString(row, 'resolution')}`
}

function collectNewEvents(
  ledger: RunLedger,
  rows: Record<string, unknown>[],
  kind: BridgeRunEvent['kind']
): void {
  for (const row of rows) {
    const key = fingerprint(kind, row)
    if (!rowString(row, 'id') || ledger.seen.has(key)) {
      continue
    }
    ledger.seen.add(key)
    ledger.events.push({
      seq: ledger.events.length + 1,
      kind,
      id: rowString(row, 'id'),
      status: rowString(row, 'status') || rowString(row, 'state'),
      data: row
    })
  }
  if (ledger.events.length > MAX_LEDGER_EVENTS) {
    ledger.events.splice(0, ledger.events.length - MAX_LEDGER_EVENTS)
  }
}

function serviceError(res: ServerResponse, error: unknown): void {
  sendBridgeJson(res, 502, { error: 'runtime_unreachable', message: String(error) })
}

function rowsOf(result: unknown, key: string): Record<string, unknown>[] {
  const rows = (result as Record<string, unknown> | null)?.[key]
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
}

/** Registers the run-proxy routes on the existing gateway; returns the unregister closure. */
export function registerOrcaBridgeRunRoutes(services: RunProxyServices): () => void {
  const unregister = [
    registerBridgeRoute({
      method: 'POST',
      path: '/v1/runs',
      handler: async ({ req, res }) => {
        let objective: string
        try {
          objective = textField(await readJsonBody(req), 'objective')
        } catch (error) {
          badRequest(res, error)
          return
        }
        try {
          const result = await services.call<{ run?: { id?: string } }>('orchestration.runCreate', {
            objective
          })
          const runId = result?.run?.id
          if (!runId) {
            serviceError(res, new Error('the runtime returned no run id'))
            return
          }
          sendBridgeJson(res, 201, { run: result.run })
        } catch (error) {
          serviceError(res, error)
        }
      }
    }),
    registerBridgeRoute({
      method: 'POST',
      path: '/v1/runs/:id/workers',
      handler: async ({ req, res, params }) => {
        let agent: string
        let brief: string
        try {
          const body = await readJsonBody(req)
          agent = textField(body, 'agent')
          brief = textField(body, 'brief')
        } catch (error) {
          badRequest(res, error)
          return
        }
        try {
          const worker = await services.call<unknown>('orchestration.workerStart', {
            run: params.id,
            agent,
            spec: brief
          })
          sendBridgeJson(res, 202, { worker })
        } catch (error) {
          serviceError(res, error)
        }
      }
    }),
    registerBridgeRoute({
      method: 'GET',
      path: '/v1/runs/:id/events',
      handler: async ({ req, res, params }) => {
        const since = Number(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('since'))
        const cursor = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0
        try {
          const [tasks, gates, inbox] = await Promise.all([
            services.call<unknown>('orchestration.taskList', { run: params.id }),
            services.call<unknown>('orchestration.gateList', { run: params.id }),
            services.call<unknown>('orchestration.inbox', { run: params.id })
          ])
          const ledger = ledgerOf(params.id)
          collectNewEvents(ledger, rowsOf(tasks, 'tasks'), 'task')
          collectNewEvents(ledger, rowsOf(gates, 'gates'), 'gate')
          collectNewEvents(ledger, rowsOf(inbox, 'messages'), 'message')
          const firstSeq = ledger.events[0]?.seq ?? cursor + 1
          const offset = Math.max(0, cursor - firstSeq + 1)
          const events = ledger.events.slice(offset)
          sendBridgeJson(res, 200, {
            runId: params.id,
            events,
            nextCursor: events.at(-1)?.seq ?? cursor
          })
        } catch (error) {
          serviceError(res, error)
        }
      }
    }),
    registerBridgeRoute({
      method: 'POST',
      path: '/v1/runs/:id/gates/:gid',
      handler: async ({ req, res, params }) => {
        let decision: string
        try {
          decision = textField(await readJsonBody(req), 'decision')
        } catch (error) {
          badRequest(res, error)
          return
        }
        try {
          const gate = await services.call<unknown>('orchestration.gateResolve', {
            id: params.gid,
            resolution: decision
          })
          sendBridgeJson(res, 202, { gate })
        } catch (error) {
          serviceError(res, error)
        }
      }
    })
  ]
  return () => {
    for (const off of unregister) {
      off()
    }
  }
}
