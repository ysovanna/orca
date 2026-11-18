// Production run-proxy services: forwards bridge /v1/runs traffic to the main-process runtime,
// over the same local RPC transport and orchestration contract version the CLI handlers use.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-environment'
import { findTransport, getRuntimeMetadataPath } from '../../../shared/runtime-bootstrap'
import type { RuntimeMetadata } from '../../../shared/runtime-bootstrap'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { sendRequest } from '../../../cli/runtime/transport'
import type { RunProxyServices } from './orca-bridge-run-proxy'

const RUN_PROXY_REQUEST_TIMEOUT_MS = 60_000
/** Only writes replay safely from a request id; reads must not look like durable mutations. */
const RUN_PROXY_MUTATION_METHODS = new Set([
  'orchestration.runCreate',
  'orchestration.workerStart',
  'orchestration.gateResolve'
])

function runtimeUserDataPath(): string {
  const userData = hasAppEnvironment()
    ? getAppEnvironment().getPath('userData')
    : process.env.ORCA_USER_DATA_PATH
  if (!userData) {
    throw new Error('the daemon has no ORCA_USER_DATA_PATH to locate the Orca runtime metadata')
  }
  return userData
}

function readRuntimeMetadata(): RuntimeMetadata {
  const metadataPath = getRuntimeMetadataPath(runtimeUserDataPath())
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as RuntimeMetadata | null
  if (!metadata?.authToken || !findTransport(metadata, 'unix', 'named-pipe')) {
    throw new Error(`Orca runtime metadata is incomplete at ${metadataPath}`)
  }
  return metadata
}

export function createRuntimeRunProxyServices(): RunProxyServices {
  return {
    async call<TResult>(method: string, params: unknown): Promise<TResult> {
      const response = await sendRequest<TResult>(
        readRuntimeMetadata(),
        method,
        params,
        RUN_PROXY_REQUEST_TIMEOUT_MS,
        {
          orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
          ...(RUN_PROXY_MUTATION_METHODS.has(method)
            ? { orchestrationRequestId: randomUUID() }
            : {})
        }
      )
      if (response.ok === false) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    }
  }
}
