// Grades a scenario by running each task's check against live network state.
// Checks read device/network state only — never the user's keystrokes — so any
// valid path to the correct config passes, exactly like the real exam.

export function grade(scenario, net) {
  return scenario.tasks.map(t => {
    let pass = false
    let error = null
    try {
      pass = !!t.check(net)
    } catch (e) {
      error = e.message
    }
    return { id: t.id, text: t.text, hint: t.hint, pass, error }
  })
}

export function scorePct(results) {
  if (!results.length) return 0
  return Math.round((results.filter(r => r.pass).length / results.length) * 100)
}

// --- reusable check helpers --------------------------------------------------

import { getInterface, canonicalIface } from './device.js'

export function vlanExists(net, devId, id) {
  const d = net.devices[devId]
  return !!(d && d.vlans && d.vlans[id])
}

export function portAccessVlan(net, devId, ifaceName) {
  const d = net.devices[devId]
  if (!d) return null
  const ifc = d.interfaces[canonicalIface(ifaceName)]
  if (!ifc || ifc.mode !== 'access') return null
  return ifc.accessVlan || 1
}

export function portIsTrunk(net, devId, ifaceName) {
  const d = net.devices[devId]
  if (!d) return false
  const ifc = d.interfaces[canonicalIface(ifaceName)]
  return !!(ifc && ifc.mode === 'trunk' && !ifc.shutdown)
}
