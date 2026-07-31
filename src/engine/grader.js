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
    // hints: [nudge, commands]; fall back to a single-level `hint` if present.
    const hints = t.hints || (t.hint ? [t.hint] : [])
    return { id: t.id, text: t.text, hints, pass, error }
  })
}

export function scorePct(results) {
  if (!results.length) return 0
  return Math.round((results.filter(r => r.pass).length / results.length) * 100)
}

// --- reusable check helpers --------------------------------------------------

import { getInterface, canonicalIface } from './device.js'
import { renderRunningConfig } from './show.js'
import { discoveryNeighbors, etherchannelUp } from './network.js'

// --- discovery protocol checks ----------------------------------------------

export function discoverySeesNeighbor(net, devId, proto, neighborId) {
  return discoveryNeighbors(net, devId, proto).some(n => n.neighborId === neighborId)
}

export function globalDiscoveryOn(net, devId, proto) {
  const d = net.devices[devId]
  if (!d) return false
  return proto === 'cdp' ? d.cdpEnabled === true : d.lldpEnabled === true
}

// --- EtherChannel checks -----------------------------------------------------

export function portInChannel(net, devId, ifaceName, id) {
  const d = net.devices[devId]
  const ifc = d && d.interfaces[canonicalIface(ifaceName)]
  return !!(ifc && ifc.channelGroup && ifc.channelGroup.id === id)
}

export function channelUp(net, devId, id) {
  return etherchannelUp(net, devId, id)
}

// True when the device has been saved AND nothing changed since (running config
// matches the saved snapshot). Never-saved devices return false.
export function isSaved(net, devId) {
  const d = net.devices[devId]
  if (!d || d.savedConfig == null) return false
  return d.savedConfig === renderRunningConfig(d).join('\n')
}

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
