// Multi-device network: devices + physical links, with an L2 forwarding
// simulation good enough to grade VLAN/trunking connectivity.
//
// The reachability model floods a frame carrying a VLAN through the switched
// topology, honoring access/trunk port rules, and reports which endpoints it
// reaches. ping() layers same-subnet ARP+ICMP on top of that. Inter-VLAN (L3)
// routing arrives with the IP Connectivity phase.

import { getInterface } from './device.js'

export function createNetwork() {
  return { devices: {}, links: [] }
}

export function addDevice(net, dev) {
  net.devices[dev.id] = dev
  return dev
}

// Wire (devA, portA) <-> (devB, portB). For switches/routers portX is an
// interface name; for hosts use their nic name (e.g. 'NIC').
export function addLink(net, aId, aPort, bId, bPort) {
  net.links.push({ a: { devId: aId, port: aPort }, b: { devId: bId, port: bPort } })
  markConnected(net, aId, aPort)
  markConnected(net, bId, bPort)
}

function markConnected(net, devId, port) {
  const dev = net.devices[devId]
  if (!dev || dev.kind === 'host') return
  const ifc = getInterface(dev, port)
  if (ifc) { ifc.connected = true; ifc.lineProtocol = !ifc.shutdown }
}

// Find what's on the other end of (devId, port). Returns {devId, port} | null.
export function neighbor(net, devId, port) {
  for (const l of net.links) {
    if (l.a.devId === devId && l.a.port === port) return l.b
    if (l.b.devId === devId && l.b.port === port) return l.a
  }
  return null
}

// --- L2 forwarding -----------------------------------------------------------

// Does a switch port carry `vlan`, and is it usable (up + connected)?
function portCarries(ifc, vlan) {
  if (!ifc || ifc.shutdown) return false
  if (ifc.mode === 'access') return (ifc.accessVlan || 1) === vlan
  if (ifc.mode === 'trunk') {
    if (ifc.trunkAllowed === 'all') return true
    return Array.isArray(ifc.trunkAllowed) && ifc.trunkAllowed.includes(vlan)
  }
  return false
}

// Flood a frame with `vlan` starting at (startDevId) switch fabric, collecting
// the set of host endpoints it reaches. BFS over switches through trunk/access
// links that carry the VLAN.
function floodVlan(net, startDevId, vlan) {
  const reachedHosts = new Set()
  const visitedSwitches = new Set()
  const queue = [startDevId]

  while (queue.length) {
    const devId = queue.shift()
    if (visitedSwitches.has(devId)) continue
    visitedSwitches.add(devId)
    const dev = net.devices[devId]
    if (!dev || dev.kind !== 'switch') continue

    for (const ifc of Object.values(dev.interfaces)) {
      if (!portCarries(ifc, vlan)) continue
      const nb = neighbor(net, devId, ifc.name)
      if (!nb) continue
      const nbDev = net.devices[nb.devId]
      if (!nbDev) continue

      if (nbDev.kind === 'host') {
        // Host is reachable only if this switch port places it in `vlan`.
        if (ifc.mode === 'access' && (ifc.accessVlan || 1) === vlan) {
          reachedHosts.add(nbDev.id)
        }
      } else if (nbDev.kind === 'switch') {
        const nbIfc = getInterface(nbDev, nb.port)
        if (portCarries(nbIfc, vlan)) queue.push(nbDev.id)
      }
    }
  }
  return reachedHosts
}

// The VLAN a host sits in = the access VLAN of the switch port it connects to.
export function hostVlan(net, hostId) {
  const link = net.links.find(l =>
    (l.a.devId === hostId) || (l.b.devId === hostId))
  if (!link) return null
  const swSide = link.a.devId === hostId ? link.b : link.a
  const sw = net.devices[swSide.devId]
  if (!sw || sw.kind !== 'switch') return null
  const ifc = getInterface(sw, swSide.port)
  if (!ifc || ifc.shutdown || ifc.mode !== 'access') return null
  return { vlan: ifc.accessVlan || 1, switchId: sw.id }
}

// --- discovery protocols (CDP / LLDP) ----------------------------------------

function capabilityCode(dev) {
  return dev.kind === 'router' ? 'R' : dev.kind === 'switch' ? 'S' : 'H'
}

// Neighbors visible via a discovery protocol. `proto` is 'cdp' or 'lldp'.
// A neighbor appears only if the protocol is enabled on both ends (globally,
// and per-interface for CDP) and the local port is up and connected.
export function discoveryNeighbors(net, devId, proto) {
  const dev = net.devices[devId]
  if (!dev || dev.kind === 'host') return []
  const globalOn = proto === 'cdp' ? dev.cdpEnabled : dev.lldpEnabled
  if (!globalOn) return []

  const out = []
  for (const ifc of Object.values(dev.interfaces)) {
    if (ifc.shutdown || !ifc.connected) continue
    if (proto === 'cdp' && !ifc.cdpEnabled) continue
    if (proto === 'lldp' && !ifc.lldpTx) continue

    const nb = neighbor(net, devId, ifc.name)
    if (!nb) continue
    const nbDev = net.devices[nb.devId]
    if (!nbDev || nbDev.kind === 'host') continue

    const nbGlobal = proto === 'cdp' ? nbDev.cdpEnabled : nbDev.lldpEnabled
    if (!nbGlobal) continue
    const nbIfc = getInterface(nbDev, nb.port)
    if (!nbIfc || nbIfc.shutdown) continue
    if (proto === 'cdp' && !nbIfc.cdpEnabled) continue
    if (proto === 'lldp' && !nbIfc.lldpRx) continue

    out.push({
      neighborId: nbDev.id,
      neighborName: nbDev.hostname,
      localPort: ifc.shortName,
      remotePort: nbIfc.shortName,
      capability: capabilityCode(nbDev),
      platform: nbDev.kind === 'router' ? 'CCNA-Router' : 'CCNA-Switch',
    })
  }
  return out
}

// --- EtherChannel ------------------------------------------------------------

// LACP/PAgP-style compatibility: on+on, or active/passive combos (but not
// passive+passive). `on` never bundles with active/passive.
export function modesCompatible(a, b) {
  if (!a || !b) return false
  if (a === 'on' || b === 'on') return a === 'on' && b === 'on'
  if (a === 'passive' && b === 'passive') return false
  return true // active/active, active/passive, passive/active
}

// Is Port-channel `poId` on `devId` actually bundled (member ports linked to a
// neighbor whose corresponding ports share the channel with compatible modes)?
export function etherchannelUp(net, devId, poId) {
  const dev = net.devices[devId]
  const po = dev?.portChannels?.[poId]
  if (!po || po.members.length === 0) return false

  for (const memberName of po.members) {
    const ifc = getInterface(dev, memberName)
    if (!ifc || ifc.shutdown || !ifc.channelGroup) continue
    const nb = neighbor(net, devId, memberName)
    if (!nb) continue
    const nbDev = net.devices[nb.devId]
    const nbIfc = nbDev && getInterface(nbDev, nb.port)
    if (!nbIfc || !nbIfc.channelGroup) continue
    if (modesCompatible(ifc.channelGroup.mode, nbIfc.channelGroup.mode)) return true
  }
  return false
}

// --- reachability / ping -----------------------------------------------------

function sameSubnet(ipA, ipB, mask) {
  const net = (ip) => ip.split('.').map(Number)
  const m = net(mask), a = net(ipA), b = net(ipB)
  for (let i = 0; i < 4; i++) {
    if ((a[i] & m[i]) !== (b[i] & m[i])) return false
  }
  return true
}

// L2 host-to-host reachability within a VLAN (used for same-subnet delivery
// across switches). Returns { ok, reason }. Does not check subnetting — callers
// decide when L2 delivery applies.
export function l2HostReach(net, srcId, dstIp) {
  const src = net.devices[srcId]
  if (!src || src.kind !== 'host' || !src.ip) return { ok: false, reason: 'source has no IP' }
  const dst = Object.values(net.devices).find(d => d.kind === 'host' && d.ip === dstIp)
  if (!dst) return { ok: false, reason: 'destination unknown' }
  const sv = hostVlan(net, srcId)
  if (!sv) return { ok: false, reason: 'source port down or not access' }
  const reached = floodVlan(net, sv.switchId, sv.vlan)
  return reached.has(dst.id)
    ? { ok: true, reason: 'reply' }
    : { ok: false, reason: 'no L2 path in VLAN ' + sv.vlan }
}

// Can host `srcId` reach IP `dstIp`? Returns { ok, reason }.
// Same-subnet L2 path only. Superseded by l3.ping for cross-subnet routing.
export function ping(net, srcId, dstIp) {
  const src = net.devices[srcId]
  if (!src || src.kind !== 'host') return { ok: false, reason: 'no source host' }
  if (!src.ip || !src.mask) return { ok: false, reason: 'source has no IP' }

  const dst = Object.values(net.devices).find(d => d.kind === 'host' && d.ip === dstIp)
  if (!dst) return { ok: false, reason: 'destination unknown' }

  if (!sameSubnet(src.ip, dstIp, src.mask)) {
    return { ok: false, reason: 'different subnet (needs a router)' }
  }

  const sv = hostVlan(net, srcId)
  if (!sv) return { ok: false, reason: 'source port down or not access' }

  const reached = floodVlan(net, sv.switchId, sv.vlan)
  if (reached.has(dst.id)) return { ok: true, reason: 'reply' }
  return { ok: false, reason: 'no L2 path in VLAN ' + sv.vlan }
}
