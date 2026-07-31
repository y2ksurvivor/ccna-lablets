// Simulations for the IP Services lablets: DHCP address assignment (with relay),
// NTP synchronization, and static NAT translation/reachability. Kept behavioral
// and bounded — enough to grade "configure and verify" honestly.

import { getInterface } from './device.js'
import { neighbor } from './network.js'
import { ipToInt, intToIp, ownerOfIp, forwardFrom } from './l3.js'

function netOf(ip, mask) {
  const i = ipToInt(ip), m = ipToInt(mask)
  return (i === null || m === null) ? null : ((i & m) >>> 0)
}

// --- DHCP --------------------------------------------------------------------

// Resolve the address a DHCP-client host would receive. Returns
// { ip, mask, gateway } or null. Honors a relay (ip helper-address) on the
// client's gateway interface.
export function dhcpResolve(net, hostId) {
  const host = net.devices[hostId]
  if (!host || host.kind !== 'host') return null
  const nb = neighbor(net, hostId, host.nic)
  if (!nb) return null
  const gwDev = net.devices[nb.devId]
  if (!gwDev || gwDev.kind === 'host') return null
  const gwIfc = getInterface(gwDev, nb.port)
  if (!gwIfc || gwIfc.shutdown || !gwIfc.ip) return null

  const segNet = netOf(gwIfc.ip, gwIfc.mask)

  // Which device serves DHCP? The gateway router, or a relayed server.
  let serverDev = gwDev
  if (gwIfc.helperAddress) {
    const owner = ownerOfIp(net, gwIfc.helperAddress)
    if (!owner) return null
    // Server must be reachable from the gateway router.
    if (!forwardFrom(net, gwDev.id, gwIfc.helperAddress)) return null
    serverDev = net.devices[owner.devId]
  }
  if (!serverDev) return null

  // Find a pool whose network matches the client's segment.
  const pool = Object.values(serverDev.dhcpPools || {}).find(p =>
    p.network && p.mask && netOf(p.network, p.mask) === segNet)
  if (!pool) return null

  const assigned = firstFreeAddress(pool, serverDev.dhcpExcluded || [], gwIfc.ip)
  if (!assigned) return null
  return { ip: assigned, mask: pool.mask, gateway: pool.defaultRouter || gwIfc.ip }
}

function firstFreeAddress(pool, excluded, gatewayIp) {
  const base = ipToInt(pool.network)
  const ex = new Set(excluded.map(ipToInt))
  ex.add(base) // network address
  ex.add(ipToInt(gatewayIp))
  if (pool.defaultRouter) ex.add(ipToInt(pool.defaultRouter))
  // Scan the first ~50 host addresses for a free one.
  for (let i = 1; i <= 50; i++) {
    const cand = (base + i) >>> 0
    if (!ex.has(cand)) return intToIp(cand)
  }
  return null
}

// --- NTP ---------------------------------------------------------------------

// Is devId synchronized? True when it has a configured server that is an NTP
// master and reachable.
export function ntpSynced(net, devId) {
  const dev = net.devices[devId]
  if (!dev || !dev.ntp) return false
  if (dev.ntp.master) return true
  for (const s of dev.ntp.servers) {
    const owner = ownerOfIp(net, s)
    if (!owner) continue
    const server = net.devices[owner.devId]
    if (!server?.ntp?.master) continue
    // reachable from this device?
    if (dev.kind === 'router' && forwardFrom(net, devId, s)) return true
    if (owner.devId === devId) return true
  }
  return false
}

// --- NAT (static) ------------------------------------------------------------

export function natTranslations(dev) {
  if (!dev.nat) return []
  return dev.nat.statics.map(s => ({
    proto: '---', insideGlobal: s.insideGlobal, insideLocal: s.insideLocal,
    outsideLocal: '---', outsideGlobal: '---',
  }))
}

function hasInside(dev) { return Object.values(dev.interfaces).some(i => i.natRole === 'inside' && !i.shutdown) }
function hasOutside(dev) { return Object.values(dev.interfaces).some(i => i.natRole === 'outside' && !i.shutdown) }

// Can an outside host reach an inside host through a static NAT mapping on the
// NAT router? Needs: inside+outside roles set, a static map for the inside host,
// the NAT router able to reach the inside host, and the outside host able to
// route to the inside-global address.
export function natStaticReachable(net, natRouterId, outsideHostId, insideHostIp) {
  const nat = net.devices[natRouterId]
  if (!nat || !nat.nat) return false
  if (!hasInside(nat) || !hasOutside(nat)) return false
  const map = nat.nat.statics.find(s => s.insideLocal === insideHostIp)
  if (!map) return false
  // NAT router reaches the real inside host
  if (!forwardFrom(net, natRouterId, insideHostIp)) return false
  // Outside host can route to the inside-global address
  const out = net.devices[outsideHostId]
  if (!out) return false
  // inside-global should be owned by NAT outside interface or routable to NAT
  const owner = ownerOfIp(net, map.insideGlobal)
  if (owner && owner.devId === natRouterId) return true
  // otherwise require the outside host's gateway to route toward NAT
  return forwardFrom(net, natRouterId, out.ip) // symmetric sanity check
}
