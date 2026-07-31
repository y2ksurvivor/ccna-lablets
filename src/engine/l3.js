// Layer-3 routing engine: routing tables (connected/static/OSPF), longest-prefix
// forwarding, and cross-subnet ping. OSPF routes come from a small SPF over the
// adjacency graph. Routing-lab topologies use direct router-to-router and
// host-to-router links (no switches in between), which keeps next-hop
// resolution to neighbor() lookups.

import { getInterface } from './device.js'
import { neighbor, l2HostReach, floodVlan } from './network.js'

// --- address math ------------------------------------------------------------

export function ipToInt(ip) {
  const p = String(ip).split('.').map(Number)
  if (p.length !== 4 || p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return null
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
}
export function maskToLen(mask) {
  const m = ipToInt(mask)
  if (m === null) return null
  let len = 0, v = m
  for (let i = 0; i < 32; i++) { if (v & 0x80000000) len++; v = (v << 1) >>> 0 }
  return len
}
export function wildcardToMask(wc) {
  const w = ipToInt(wc)
  return w === null ? null : ((~w) >>> 0)
}
function netOf(ipInt, maskInt) { return (ipInt & maskInt) >>> 0 }
function inSubnet(ipInt, netInt, maskInt) { return (ipInt & maskInt) >>> 0 === netInt }
export function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}
export function lenToMask(len) {
  const m = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0
  return intToIp(m)
}

// --- routing table -----------------------------------------------------------

function connectedRoutes(dev) {
  const out = []
  for (const ifc of Object.values(dev.interfaces)) {
    if (ifc.shutdown || !ifc.ip || !ifc.mask) continue
    const ipInt = ipToInt(ifc.ip), maskInt = ipToInt(ifc.mask)
    if (ipInt === null || maskInt === null) continue
    out.push({
      proto: 'C', netInt: netOf(ipInt, maskInt), maskInt,
      prefix: intToIp(netOf(ipInt, maskInt)), mask: ifc.mask,
      iface: ifc.name, nextHop: null, ad: 0, metric: 0, connected: true,
    })
  }
  return out
}

function staticRoutesOf(dev) {
  return (dev.routes || []).map(r => {
    const netInt = netOf(ipToInt(r.prefix), ipToInt(r.mask))
    return {
      proto: 'S', netInt, maskInt: ipToInt(r.mask),
      prefix: r.prefix, mask: r.mask, nextHop: r.nextHop,
      iface: null, ad: r.ad ?? 1, metric: r.metric ?? 0,
      isDefault: r.prefix === '0.0.0.0' && r.mask === '0.0.0.0',
    }
  })
}

// Full routing table: connected + static + OSPF, best route per prefix.
export function routingTable(net, dev) {
  const all = [...connectedRoutes(dev), ...staticRoutesOf(dev), ...ospfRoutes(net, dev)]
  const best = new Map() // key: net/mask -> route
  for (const r of all) {
    const key = `${r.netInt}/${r.maskInt}`
    const cur = best.get(key)
    if (!cur || r.ad < cur.ad || (r.ad === cur.ad && r.metric < cur.metric)) best.set(key, r)
  }
  return [...best.values()]
}

// Longest-prefix match, then lowest AD, then lowest metric.
export function routeLookup(net, dev, destIp) {
  const d = ipToInt(destIp)
  if (d === null) return null
  let best = null
  for (const r of routingTable(net, dev)) {
    if (!inSubnet(d, r.netInt, r.maskInt)) continue
    if (!best ||
      r.maskInt >>> 0 > best.maskInt >>> 0 ||
      (r.maskInt === best.maskInt && r.ad < best.ad)) {
      best = r
    }
  }
  return best
}

// --- ownership / adjacency ---------------------------------------------------

export function ownerOfIp(net, ip) {
  for (const dev of Object.values(net.devices)) {
    if (dev.kind === 'host') {
      if (dev.ip === ip) return { devId: dev.id, host: true }
    } else {
      for (const ifc of Object.values(dev.interfaces)) {
        if (ifc.ip === ip && !ifc.shutdown) return { devId: dev.id, iface: ifc.name }
      }
    }
  }
  return null
}

// Resolve a next-hop IP to { nextRouter, exitPort, ingressPort } across a
// directly connected subnet. Also used to know which interface a packet exits
// (for outbound ACLs) and which it enters on the neighbor (for inbound ACLs).
function resolveNextHop(net, routerId, nextHopIp) {
  const dev = net.devices[routerId]
  const nh = ipToInt(nextHopIp)
  for (const ifc of Object.values(dev.interfaces)) {
    if (ifc.shutdown || !ifc.ip || !ifc.mask) continue
    const maskInt = ipToInt(ifc.mask)
    if (!inSubnet(nh, netOf(ipToInt(ifc.ip), maskInt), maskInt)) continue
    const nb = neighbor(net, routerId, ifc.name)
    if (!nb) continue
    const nbDev = net.devices[nb.devId]
    if (!nbDev || nbDev.kind === 'host') continue
    const nbIfc = getInterface(nbDev, nb.port)
    if (nbIfc && nbIfc.ip === nextHopIp && !nbIfc.shutdown) {
      return { nextRouter: nbDev.id, exitPort: ifc.name, ingressPort: nbIfc.name }
    }
  }
  return null
}

// --- ACL evaluation ----------------------------------------------------------

function addrMatches(addr, ip) {
  if (!addr || addr.any) return true
  if (!ip) return false
  const wc = ipToInt(addr.wildcard || '0.0.0.0')
  const mask = (~wc) >>> 0
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(addr.ip) & mask) >>> 0)
}

function aclEntryMatches(e, srcIp, destIp) {
  if (!addrMatches(e.src, srcIp)) return false
  if (e.kind === 'extended' && e.dst && !addrMatches(e.dst, destIp)) return false
  return true
}

// Does ACL `aclId` on `dev` permit this packet? An undefined/empty ACL permits;
// a defined ACL ends in an implicit deny.
export function aclPermits(dev, aclId, srcIp, destIp) {
  if (!aclId) return true
  const entries = dev.acls?.[aclId]
  if (!entries || !entries.length) return true
  for (const e of entries) {
    if (aclEntryMatches(e, srcIp, destIp)) return e.action === 'permit'
  }
  return false
}

// Deliver destIp on a directly connected interface. The wire may lead to a
// host, another router, or a switched segment (flood the VLAN to find the host).
function connectedDelivers(net, routerId, ifaceName, destIp) {
  const nb = neighbor(net, routerId, ifaceName)
  if (!nb) return false
  const nbDev = net.devices[nb.devId]
  if (!nbDev) return false
  if (nbDev.kind === 'host') return nbDev.ip === destIp && !!nbDev.ip
  if (nbDev.kind === 'switch') {
    const entryIfc = getInterface(nbDev, nb.port)
    const vlan = entryIfc && entryIfc.mode === 'access' ? (entryIfc.accessVlan || 1) : 1
    for (const hid of floodVlan(net, nbDev.id, vlan)) {
      if (net.devices[hid]?.ip === destIp) return true
    }
    return false
  }
  const nbIfc = getInterface(nbDev, nb.port)
  return !!(nbIfc && nbIfc.ip === destIp && !nbIfc.shutdown)
}

// --- forwarding --------------------------------------------------------------

// Can routerId deliver a packet to destIp? Follows the routing table hop by hop,
// enforcing inbound ACLs (on the arrival interface) and outbound ACLs (on the
// exit interface). srcIp enables ACL checks; pass null for control-plane checks.
export function forwardFrom(net, routerId, destIp, srcIp = null, ingressIface = null, ttl = 16) {
  if (ttl <= 0) return false
  const dev = net.devices[routerId]
  if (!dev) return false
  // Inbound ACL on the interface the packet arrived on.
  if (srcIp && ingressIface) {
    const inIfc = getInterface(dev, ingressIface)
    if (inIfc && !aclPermits(dev, inIfc.accessGroupIn, srcIp, destIp)) return false
  }
  // Router owns the destination itself?
  for (const ifc of Object.values(dev.interfaces)) {
    if (ifc.ip === destIp && !ifc.shutdown) return true
  }
  const route = routeLookup(net, dev, destIp)
  if (!route) return false
  if (route.connected) {
    const exitIfc = getInterface(dev, route.iface)
    if (srcIp && exitIfc && !aclPermits(dev, exitIfc.accessGroupOut, srcIp, destIp)) return false
    return connectedDelivers(net, routerId, route.iface, destIp)
  }
  const hop = resolveNextHop(net, routerId, route.nextHop)
  if (!hop) return false
  const exitIfc = getInterface(dev, hop.exitPort)
  if (srcIp && exitIfc && !aclPermits(dev, exitIfc.accessGroupOut, srcIp, destIp)) return false
  return forwardFrom(net, hop.nextRouter, destIp, srcIp, hop.ingressPort, ttl - 1)
}

function sameSubnet(aIp, bIp, mask) {
  const m = ipToInt(mask)
  return netOf(ipToInt(aIp), m) === netOf(ipToInt(bIp), m)
}

// One-way delivery from a host to destIp (same subnet direct, else via gateway).
function hostForward(net, hostId, destIp) {
  const host = net.devices[hostId]
  if (!host || !host.ip) return false
  if (sameSubnet(host.ip, destIp, host.mask)) {
    // Directly-connected neighbor owns it? (host->router gateway, or host->host)
    const nb = neighbor(net, hostId, host.nic)
    if (nb) {
      const dev = net.devices[nb.devId]
      if (dev?.kind === 'host' && dev.ip === destIp) return true
      if (dev && dev.kind !== 'host') {
        const ifc = getInterface(dev, nb.port)
        if (ifc && ifc.ip === destIp && !ifc.shutdown) return true
      }
    }
    // Otherwise fall back to switched L2 reachability (VLAN scenarios).
    return l2HostReach(net, hostId, destIp).ok
  }
  // Enter the gateway router on the interface that owns the gateway IP (which
  // may sit across a switched segment), carrying the real source IP so ACLs
  // along the path can match it.
  if (!host.gateway) return false
  const gwOwner = ownerOfIp(net, host.gateway)
  if (!gwOwner || gwOwner.host) return false
  const gwDev = net.devices[gwOwner.devId]
  const gwIfc = getInterface(gwDev, gwOwner.iface)
  if (!gwIfc || gwIfc.shutdown) return false
  return forwardFrom(net, gwDev.id, destIp, host.ip, gwIfc.name)
}

// Unified host ping used everywhere: same-subnet L2 (incl. VLANs) or routed
// L3. Needs both forward and return paths (ICMP echo + reply).
export function ping(net, srcHostId, destIp) {
  const src = net.devices[srcHostId]
  if (!src || !src.ip) return { ok: false, reason: 'source has no IP' }
  const dstOwner = ownerOfIp(net, destIp)
  if (!dstOwner) return { ok: false, reason: 'destination unknown' }

  const forward = hostForward(net, srcHostId, destIp)
  if (!forward) return { ok: false, reason: 'no route to destination' }

  // Return path: destination host (or router) must reach the source IP back.
  let back
  if (dstOwner.host) back = hostForward(net, dstOwner.devId, src.ip)
  else back = forwardFrom(net, dstOwner.devId, src.ip)
  if (!back) return { ok: false, reason: 'no return route' }

  return { ok: true, reason: 'reply' }
}

// --- OSPF (single area SPF) --------------------------------------------------

// Interfaces this router runs OSPF on (matched by a network statement + area).
function ospfInterfaces(dev) {
  if (!dev.ospf) return []
  const out = []
  for (const ifc of Object.values(dev.interfaces)) {
    if (ifc.shutdown || !ifc.ip) continue
    const ipInt = ipToInt(ifc.ip)
    for (const stmt of dev.ospf.networks) {
      const wcMask = wildcardToMask(stmt.wildcard)
      const stmtNet = netOf(ipToInt(stmt.ip), wcMask)
      if (netOf(ipInt, wcMask) === stmtNet) {
        out.push({ iface: ifc, area: stmt.area, passive: dev.ospf.passive?.includes(ifc.name) })
        break
      }
    }
  }
  return out
}

// Build the OSPF adjacency graph across the network: nodes = OSPF routers,
// edges = links where both ends run OSPF in the same area (and neither is passive).
function ospfGraph(net) {
  const routers = Object.values(net.devices).filter(d => d.kind === 'router' && d.ospf)
  const adj = {} // routerId -> [{to, viaIfaceIp of neighbor (next hop), cost}]
  for (const r of routers) adj[r.id] = []
  for (const r of routers) {
    for (const { iface, area, passive } of ospfInterfaces(r)) {
      if (passive) continue
      const nb = neighbor(net, r.id, iface.name)
      if (!nb) continue
      const nbDev = net.devices[nb.devId]
      if (!nbDev || nbDev.kind !== 'router' || !nbDev.ospf) continue
      const nbIfc = getInterface(nbDev, nb.port)
      if (!nbIfc || nbIfc.shutdown || !nbIfc.ip) continue
      // neighbor must run OSPF on that interface, same area
      const nbOspf = ospfInterfaces(nbDev).find(o => o.iface.name === nbIfc.name && !o.passive)
      if (!nbOspf || nbOspf.area !== area) continue
      adj[r.id].push({ to: nbDev.id, nextHop: nbIfc.ip, cost: 1 })
    }
  }
  return { routers, adj }
}

export function ospfNeighbors(net, routerId) {
  const { adj } = ospfGraph(net)
  return (adj[routerId] || []).map(e => ({ id: e.to, ip: e.nextHop }))
}

// Dijkstra from source router; returns map routerId -> {cost, firstHop}.
function ospfSpf(net, sourceId) {
  const { adj } = ospfGraph(net)
  const dist = { [sourceId]: 0 }
  const firstHop = { [sourceId]: null }
  const visited = new Set()
  while (true) {
    let u = null, ud = Infinity
    for (const [k, d] of Object.entries(dist)) {
      if (!visited.has(k) && d < ud) { u = k; ud = d }
    }
    if (u === null) break
    visited.add(u)
    for (const e of adj[u] || []) {
      const nd = ud + e.cost
      if (nd < (dist[e.to] ?? Infinity)) {
        dist[e.to] = nd
        firstHop[e.to] = u === sourceId ? { nextHop: e.nextHop } : firstHop[u]
      }
    }
  }
  const out = {}
  for (const k of Object.keys(dist)) out[k] = { cost: dist[k], firstHop: firstHop[k] }
  return out
}

// OSPF-learned routes for dev: every other OSPF router's advertised subnets,
// reached via the SPF first hop.
export function ospfRoutes(net, dev) {
  if (!dev.ospf) return []
  const spf = ospfSpf(net, dev.id)
  const out = []
  for (const [rid, info] of Object.entries(spf)) {
    if (rid === dev.id || !info.firstHop) continue
    const router = net.devices[rid]
    for (const { iface, area } of ospfInterfaces(router)) {
      const ipInt = ipToInt(iface.ip), maskInt = ipToInt(iface.mask)
      out.push({
        proto: 'O', netInt: netOf(ipInt, maskInt), maskInt,
        prefix: intToIp(netOf(ipInt, maskInt)), mask: iface.mask,
        nextHop: info.firstHop.nextHop, iface: null,
        ad: 110, metric: info.cost + 1,
      })
    }
  }
  return out
}
