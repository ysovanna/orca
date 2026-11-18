// Shared JSON body reading for every bridge gateway route.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendBridgeJson } from '../../daemon/endpoint/http-gateway'

/** Largest card, steer or gate body the bridge reads; larger bodies are rejected as invalid. */
export const BRIDGE_BODY_LIMIT = 1_000_000

/** Body problems are the caller's fault, so they answer 400 instead of the gateway's 500. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk as Buffer)
    if (size > BRIDGE_BODY_LIMIT) {
      throw new Error(`request body exceeds the ${BRIDGE_BODY_LIMIT} byte bridge limit`)
    }
    chunks.push(Buffer.from(chunk as Buffer))
  }
  if (size === 0) {
    throw new Error('a JSON request body is required')
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

export function textField(body: unknown, name: string): string {
  const value = (body as Record<string, unknown> | null)?.[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

export function badRequest(res: ServerResponse, error: unknown): void {
  sendBridgeJson(res, 400, { error: 'invalid_request', message: String(error) })
}

export function notFound(res: ServerResponse, id: string): void {
  sendBridgeJson(res, 404, { error: 'not_found', id })
}
