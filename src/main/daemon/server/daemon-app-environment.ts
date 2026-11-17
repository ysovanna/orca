// The detached daemon has no Electron; bridge dispatch resolves app paths via AppEnvironment.
// Install a Node environment only when the bridge gateway is enabled, so bridge-less daemons
// keep their existing no-environment fallbacks (see daemon-launched-child-spawn.ts).
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { hasAppEnvironment, setAppEnvironment } from '../../../shared/app-environment'
import { createNodeServiceEnvironment } from '../../backend/node-service-environment'
import { BRIDGE_TOKEN_ENV } from '../endpoint/http-gateway'

/** The spawner's userData handoff; the daemon's only trustworthy user-data root. */
const DAEMON_USER_DATA_ENV = 'ORCA_USER_DATA_PATH'

export function installDaemonBridgeAppEnvironment(appVersion?: string): void {
  if (hasAppEnvironment() || !process.env[BRIDGE_TOKEN_ENV]) {
    return
  }
  const userData = process.env[DAEMON_USER_DATA_ENV]
  if (!userData) {
    console.warn(
      '[daemon] Bridge enabled but ORCA_USER_DATA_PATH is unset; bridge dispatch will fail path resolution.'
    )
    return
  }
  setAppEnvironment(
    createNodeServiceEnvironment({
      getPath: (name) => {
        switch (name) {
          case 'userData':
            return userData
          case 'home':
            return homedir()
          case 'temp':
            return tmpdir()
          case 'appData':
            return (
              process.env.APPDATA ??
              (process.platform === 'darwin'
                ? join(homedir(), 'Library', 'Application Support')
                : join(homedir(), '.config'))
            )
          case 'logs':
            return join(userData, 'logs')
          case 'downloads':
            return join(homedir(), 'Downloads')
          case 'exe':
            return process.execPath
        }
      },
      getAppPath: () => dirname(process.execPath),
      getVersion: () => appVersion ?? process.env.ORCA_APP_VERSION ?? '0.0.0-daemon',
      isPackaged: () => true
    }).environment
  )
}
