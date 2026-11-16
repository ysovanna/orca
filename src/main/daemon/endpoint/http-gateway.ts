import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

/** Loopback HTTP surface for the Orca Bridge; inert unless ORCA_BRIDGE_TOKEN is set. */

export const BRIDGE_TOKEN_ENV = 'ORCA_BRIDGE_TOKEN'
export const BRIDGE_PORT_ENV = 'ORCA_BRIDGE_PORT'
export const BRIDGE_DEFAULT_PORT = 46_133
export const BRIDGE_HOST = '127.0.0.1'

export type BridgeRequestContext = {
  req: IncomingMessage
  res: ServerResponse
  /** Values of `:name` segments in the registered path. */
  params: Record<string, string>
}

export type BridgeRouteHandler = (ctx: BridgeRequestContext) => void | Promise<void>

/** One dispatch route. OB-2 registers the agent catalog, dispatch, steer and gate routes here. */
export type BridgeRoute = {
  method: 'GET' | 'POST' | 'DELETE'
  /** Absolute path pattern, e.g. `/v1/agents` or `/v1/sessions/:id/steer`. */
  path: string
  handler: BridgeRouteHandler
}

export type BridgeGatewayHandle = { port: number }

type GatewayState = { server: Server; port: number }

const routes = new Map<string, BridgeRoute>()
let state: GatewayState | null = null

function routeKey(method: BridgeRoute['method'], path: string): string {
  return `${method} ${path}`
}

/** Registers a route for the lifetime of the gateway; returns an unregister function. */
export function registerBridgeRoute(route: BridgeRoute): () => void {
  const key = routeKey(route.method, route.path)
  routes.set(key, route)
  return () => {
    if (routes.get(key) === route) {
      routes.delete(key)
    }
  }
}

export function sendBridgeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  })
  res.end(payload)
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  if (typeof header !== 'string') {
    return false
  }
  const [scheme, ...rest] = header.split(' ')
  return rest.length === 1 && scheme.toLowerCase() === 'bearer' && tokenMatches(rest[0], token)
}

function matchRoute(
  method: string,
  pathname: string
): { route: BridgeRoute; params: Record<string, string> } | null {
  for (const [key, route] of routes) {
    const separator = key.indexOf(' ')
    if (key.slice(0, separator) !== method) {
      continue
    }
    const params = matchSegments(key.slice(separator + 1), pathname)
    if (params) {
      return { route, params }
    }
  }
  return null
}

function matchSegments(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean)
  const pathParts = pathname.split('/').filter(Boolean)
  if (patternParts.length !== pathParts.length) {
    return null
  }
  const params: Record<string, string> = {}
  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i]
    if (part.startsWith(':')) {
      params[part.slice(1)] = decodeURIComponent(pathParts[i])
    } else if (part !== pathParts[i]) {
      return null
    }
  }
  return params
}

function gatewayToken(): string | null {
  const token = process.env[BRIDGE_TOKEN_ENV]
  return token && token.length > 0 ? token : null
}

function gatewayPort(): number {
  const raw = process.env[BRIDGE_PORT_ENV]
  const port = raw ? Number(raw) : BRIDGE_DEFAULT_PORT
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : BRIDGE_DEFAULT_PORT
}

async function handle(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  const method = req.method ?? 'GET'
  const pathname = new URL(req.url ?? '/', `http://${BRIDGE_HOST}`).pathname
  if (!isAuthorized(req, token)) {
    sendBridgeJson(res, 401, { error: 'unauthorized' })
    return
  }
  if (method === 'GET' && pathname === '/health') {
    sendBridgeJson(res, 200, { ok: true, service: 'orca-bridge' })
    return
  }
  let match: ReturnType<typeof matchRoute>
  try {
    match = matchRoute(method, pathname)
  } catch (error) {
    sendBridgeJson(res, 400, { error: 'invalid_request', message: String(error) })
    return
  }
  if (!match) {
    sendBridgeJson(res, 404, { error: 'not_found', path: pathname })
    return
  }
  try {
    await match.route.handler({ req, res, params: match.params })
  } catch (error) {
    if (!res.headersSent) {
      sendBridgeJson(res, 500, { error: 'internal_error', message: String(error) })
    } else {
      res.end()
    }
  }
}

/** Starts the loopback gateway. Returns null when disabled by env or when binding failed. */
export async function startHttpGateway(): Promise<BridgeGatewayHandle | null> {
  if (state) {
    return { port: state.port }
  }
  const token = gatewayToken()
  if (!token) {
    return null
  }
  const port = gatewayPort()
  const server = createServer((req, res) => {
    handle(req, res, token).catch((error: unknown) => {
      if (!res.headersSent) {
        sendBridgeJson(res, 500, { error: 'internal_error', message: String(error) })
      } else {
        res.end()
      }
    })
  })
  server.on('error', (error) => {
    console.warn(`[daemon] Bridge gateway error: ${error.message}`)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, BRIDGE_HOST, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (error) {
    server.close()
    console.warn(`[daemon] Bridge gateway failed to bind: ${String(error)}`)
    return null
  }
  state = { server, port }
  return { port }
}

export async function stopHttpGateway(): Promise<void> {
  const current = state
  state = null
  if (!current) {
    return
  }
  await new Promise<void>((resolve) => current.server.close(() => resolve()))
}
