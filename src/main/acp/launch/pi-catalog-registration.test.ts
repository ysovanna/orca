import { describe, expect, it } from 'vitest'
import { ACP_LAUNCH_SPECS, acpLaunchSpecFor } from './acp-launch-registry'

describe('pi bridge catalog registration', () => {
  it('lists pi in the ACP launch catalog', () => {
    const names = ACP_LAUNCH_SPECS.map((spec) => spec.agent)
    console.log(`ACP catalog agents: ${names.join(', ')}`)
    expect(names).toContain('pi')
  })

  it('launches pi as the Hermes binary on the pi profile', () => {
    const spec = acpLaunchSpecFor('pi')
    expect(spec?.command).toBe('hermes')
    expect(spec?.args({ fullAccess: false, pluginDir: null })).toEqual(['-p', 'pi', 'acp'])
  })
})
