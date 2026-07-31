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
import { ping, routeLookup, ospfNeighbors } from './l3.js'

// --- L3 / routing checks -----------------------------------------------------

export function pingWorks(net, srcHostId, destIp) {
  return ping(net, srcHostId, destIp).ok
}

// Does devId have a route that covers destIp? Optionally require a protocol
// ('C' connected, 'S' static, 'O' OSPF).
export function routeCovers(net, devId, destIp, proto = null) {
  const dev = net.devices[devId]
  if (!dev) return false
  const r = routeLookup(net, dev, destIp)
  if (!r) return false
  return proto ? r.proto === proto : true
}

export function ospfAdjacent(net, devId, neighborId) {
  return ospfNeighbors(net, devId).some(n => n.id === neighborId)
}

// --- IP services checks ------------------------------------------------------

import { dhcpResolve, ntpSynced, natStaticReachable } from './ipservices.js'
import { ipToInt } from './l3.js'

export function sshReady(net, devId) {
  const d = net.devices[devId]
  if (!d) return false
  const vty = d.lines?.vty || {}
  const transport = vty.transportInput || []
  const sshAllowed = transport.includes('ssh') || transport.includes('all')
  return !!(d.domainName && d.rsaKey && d.users.length > 0 && sshAllowed && vty.login === 'local')
}

export function ntpIsSynced(net, devId) {
  return ntpSynced(net, devId)
}

// Host receives a DHCP lease in the expected subnet.
export function dhcpLeaseInSubnet(net, hostId, network, mask) {
  const lease = dhcpResolve(net, hostId)
  if (!lease) return false
  const m = ipToInt(mask)
  return (ipToInt(lease.ip) & m) >>> 0 === (ipToInt(network) & m) >>> 0
}

export function natReachable(net, natRouterId, outsideHostId, insideHostIp) {
  return natStaticReachable(net, natRouterId, outsideHostId, insideHostIp)
}

export function ifaceNatRole(net, devId, ifaceName, role) {
  const d = net.devices[devId]
  const ifc = d && d.interfaces[canonicalIface(ifaceName)]
  return !!(ifc && ifc.natRole === role)
}

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
