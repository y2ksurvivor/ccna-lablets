// IPv6 support: address parsing, prefix math at any length, a routing table
// (connected + static) with longest-prefix forwarding, and ping. Mirrors the
// IPv4 engine in l3.js, using BigInt for 128-bit address arithmetic.

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
// --- 128-bit address math ----------------------------------------------------

export function ipv6ToBig(addr) {
  const g = expandIpv6(addr)
  if (!g) return null
  return g.reduce((acc, h) => (acc << 16n) | BigInt(parseInt(h, 16)), 0n)
}

export function bigToIpv6(n) {
  const groups = []
  for (let i = 7; i >= 0; i--) {
    groups.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16))
  }
  // Compress the longest run of zero groups, as IOS displays it.
  let bestStart = -1, bestLen = 0, runStart = -1, runLen = 0
  groups.forEach((g, i) => {
    if (g === '0') {
      if (runStart < 0) { runStart = i; runLen = 0 }
      runLen++
      if (runLen > bestLen) { bestLen = runLen; bestStart = runStart }
    } else { runStart = -1; runLen = 0 }
  })
  if (bestLen < 2) return groups.join(':')
  const head = groups.slice(0, bestStart).join(':')
  const tail = groups.slice(bestStart + bestLen).join(':')
  return `${head}::${tail}`
}

const ALL_ONES = (1n << 128n) - 1n
export function maskV6(len) {
  const n = BigInt(len)
  return n <= 0n ? 0n : (ALL_ONES << (128n - n)) & ALL_ONES
}
export function netV6(addrBig, len) {
  return addrBig & maskV6(len)
}

// Split "2001:db8::1/64" into { addr, len }. Length defaults to 128 (a host).
export function splitPrefix(spec, defaultLen = 128) {
  const [a, l] = String(spec).split('/')
  const big = ipv6ToBig(a)
  if (big === null) return null
  const len = l == null ? defaultLen : parseInt(l, 10)
  if (!Number.isInteger(len) || len < 0 || len > 128) return null
  return { addr: big, len }
}

// --- routing table -----------------------------------------------------------

function connectedRoutesV6(dev) {
  const out = []
  for (const ifc of Object.values(dev.interfaces)) {
    if (ifc.shutdown) continue
    for (const spec of (ifc.ipv6 || [])) {
      const p = splitPrefix(spec, 64)
      if (!p) continue
      out.push({
        proto: 'C', netBig: netV6(p.addr, p.len), len: p.len,
        iface: ifc.name, nextHop: null, ad: 0, connected: true,
      })
    }
  }
  return out
}

export function routingTableV6(net, dev) {
  const statics = (dev.ipv6Routes || []).map(r => ({
    proto: 'S', netBig: netV6(r.prefixBig, r.len), len: r.len,
    iface: null, nextHop: r.nextHop, ad: r.ad ?? 1,
  }))
  const best = new Map()
  for (const r of [...connectedRoutesV6(dev), ...statics]) {
    const key = `${r.netBig.toString(16)}/${r.len}`
    const cur = best.get(key)
    if (!cur || r.ad < cur.ad) best.set(key, r)
  }
  return [...best.values()]
}

export function routeLookupV6(net, dev, destBig) {
  let best = null
  for (const r of routingTableV6(net, dev)) {
    if (netV6(destBig, r.len) !== r.netBig) continue
    if (!best || r.len > best.len || (r.len === best.len && r.ad < best.ad)) best = r
  }
  return best
}

// --- forwarding --------------------------------------------------------------

function ownsV6(dev, destBig) {
  for (const ifc of Object.values(dev.interfaces)) {
    if (ifc.shutdown) continue
    for (const spec of (ifc.ipv6 || [])) {
      if (ipv6ToBig(String(spec).split('/')[0]) === destBig) return true
    }
  }
  return false
}

// Resolve an on-link next hop to { nextRouter, exitPort }.
function resolveNextHopV6(net, devId, nextHopBig) {
  const dev = net.devices[devId]
  for (const ifc of Object.values(dev.interfaces)) {
    if (ifc.shutdown) continue
    const onLink = (ifc.ipv6 || []).some(spec => {
      const p = splitPrefix(spec, 64)
      return p && netV6(nextHopBig, p.len) === netV6(p.addr, p.len)
    })
    if (!onLink) continue
    const nb = neighbor(net, devId, ifc.name)
    if (!nb) continue
    const nbDev = net.devices[nb.devId]
    if (!nbDev || nbDev.kind === 'host') continue
    const nbIfc = getInterface(nbDev, nb.port)
    if (nbIfc && !nbIfc.shutdown && ownsV6({ interfaces: { x: nbIfc } }, nextHopBig)) {
      return { nextRouter: nbDev.id, exitPort: ifc.name }
    }
  }
  return null
}

// Deliver destBig out a connected interface: the neighbour on that wire must own
// the address.
function connectedDeliversV6(net, devId, ifaceName, destBig) {
  const nb = neighbor(net, devId, ifaceName)
  if (!nb) return false
  const nbDev = net.devices[nb.devId]
  if (!nbDev || nbDev.kind === 'host') return false
  const nbIfc = getInterface(nbDev, nb.port)
  return !!(nbIfc && !nbIfc.shutdown && ownsV6({ interfaces: { x: nbIfc } }, destBig))
}

export function forwardFromV6(net, devId, destBig, ttl = 16) {
  if (ttl <= 0) return false
  const dev = net.devices[devId]
  if (!dev) return false
  if (ownsV6(dev, destBig)) return true
  // A router only forwards IPv6 with unicast routing enabled.
  if (!dev.ipv6Routing) return false
  const route = routeLookupV6(net, dev, destBig)
  if (!route) return false
  if (route.connected) return connectedDeliversV6(net, devId, route.iface, destBig)
  // route.nextHop is the address as typed; the resolver works on integers.
  const nhBig = ipv6ToBig(route.nextHop)
  if (nhBig === null) return false
  const hop = resolveNextHopV6(net, devId, nhBig)
  if (!hop) return false
  return forwardFromV6(net, hop.nextRouter, destBig, ttl - 1)
}

// Ping across the IPv6 topology: on-link or routed, and the destination must be
// able to reach a source address back.
export function pingIpv6(net, srcDevId, target) {
  const dev = net.devices[srcDevId]
  if (!dev) return { ok: false, reason: 'no device' }
  const destBig = ipv6ToBig(target)
  if (destBig === null) return { ok: false, reason: 'bad address' }

  // On-link neighbour: reachable without routing being enabled at all.
  for (const ifc of Object.values(dev.interfaces)) {
    if (ifc.shutdown || !ifaceInPrefix(ifc, target)) continue
    const nb = neighbor(net, srcDevId, ifc.name)
    if (!nb) continue
    const nbDev = net.devices[nb.devId]
    if (!nbDev || nbDev.kind === 'host') continue
    const nbIfc = getInterface(nbDev, nb.port)
    if (nbIfc && !nbIfc.shutdown && (nbIfc.ipv6 || []).some(a => normIpv6(a) === normIpv6(target))) {
      return { ok: true, reason: 'reply' }
    }
  }

  // Otherwise route it, and require a path back to one of our own addresses.
  if (!forwardFromV6(net, srcDevId, destBig)) {
    return { ok: false, reason: 'no route to destination' }
  }
  const owner = ownerOfIpv6(net, target)
  if (!owner) return { ok: false, reason: 'destination unknown' }
  const srcAddr = Object.values(dev.interfaces)
    .filter(i => !i.shutdown)
    .flatMap(i => i.ipv6 || [])[0]
  const srcBig = srcAddr ? ipv6ToBig(String(srcAddr).split('/')[0]) : null
  if (srcBig === null) return { ok: false, reason: 'no source address' }
  if (!forwardFromV6(net, owner.devId, srcBig)) {
    return { ok: false, reason: 'no return route' }
  }
  return { ok: true, reason: 'reply' }
}
