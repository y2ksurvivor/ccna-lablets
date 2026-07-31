// Minimal IPv6 support for the addressing lablet (blueprint 1.8): parse/expand
// addresses, compare /64 prefixes, and verify same-link reachability. Full IPv6
// routing is out of scope — the lablet is about correct addressing on a link.

import { getInterface } from './device.js'
import { neighbor } from './network.js'

// Expand an IPv6 address to 8 four-hex-digit groups (drops any /prefix).
export function expandIpv6(addr) {
  const a = String(addr).split('/')[0].trim().toLowerCase()
  if (!a) return null
  let groups
  if (a.includes('::')) {
    const [head, tail] = a.split('::')
    const h = head ? head.split(':') : []
    const t = tail ? tail.split(':') : []
    const missing = 8 - h.length - t.length
    if (missing < 0) return null
    groups = [...h, ...Array(missing).fill('0'), ...t]
  } else {
    groups = a.split(':')
  }
  if (groups.length !== 8) return null
  if (groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map(g => g.padStart(4, '0'))
}

// The /64 prefix (first four groups) as a normalized string, or null.
export function prefix64(addr) {
  const g = expandIpv6(addr)
  return g ? g.slice(0, 4).join(':') : null
}

// Normalized full address (no prefix) for equality checks.
export function normIpv6(addr) {
  const g = expandIpv6(addr)
  return g ? g.join(':') : null
}

// Does the interface carry an address in the same /64 as `addr`?
export function ifaceInPrefix(ifc, addr) {
  const p = prefix64(addr)
  return (ifc.ipv6 || []).some(a => prefix64(a) === p)
}

// Find the device+interface that owns `addr` (matching full address).
export function ownerOfIpv6(net, addr) {
  const target = normIpv6(addr)
  for (const dev of Object.values(net.devices)) {
    if (dev.kind === 'host') continue
    for (const ifc of Object.values(dev.interfaces)) {
      if ((ifc.ipv6 || []).some(a => normIpv6(a) === target) && !ifc.shutdown) {
        return { devId: dev.id, iface: ifc.name }
      }
    }
  }
  return null
}

// Same-link IPv6 ping: src has an interface in the target's /64, that interface
// is up, and the target is owned by a directly connected neighbor.
export function pingIpv6(net, srcDevId, target) {
  const dev = net.devices[srcDevId]
  if (!dev) return { ok: false, reason: 'no device' }
  for (const ifc of Object.values(dev.interfaces)) {
    if (ifc.shutdown) continue
    if (!ifaceInPrefix(ifc, target)) continue
    const nb = neighbor(net, srcDevId, ifc.name)
    if (!nb) continue
    const nbDev = net.devices[nb.devId]
    if (!nbDev || nbDev.kind === 'host') continue
    const nbIfc = getInterface(nbDev, nb.port)
    if (nbIfc && !nbIfc.shutdown && (nbIfc.ipv6 || []).some(a => normIpv6(a) === normIpv6(target))) {
      return { ok: true, reason: 'reply' }
    }
  }
  return { ok: false, reason: 'no on-link neighbor with that address' }
}
