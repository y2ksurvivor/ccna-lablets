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

import { getInterface, canonicalIface, hasObserved } from './device.js'
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

export function ospfRouterIdIs(net, devId, routerId) {
  return net.devices[devId]?.ospf?.routerId === routerId
}

// A configured static route exists with this exact prefix/mask, optionally
// pinned to a next hop and/or administrative distance. Reads the configured
// routes rather than the routing table, so a floating static (higher AD, not
// installed while the primary is up) is still visible to the check.
export function hasStaticRoute(net, devId, prefix, mask, opts = {}) {
  const routes = net.devices[devId]?.routes || []
  return routes.some(r =>
    r.proto === 'S' && r.prefix === prefix && r.mask === mask &&
    (opts.nextHop == null || r.nextHop === opts.nextHop) &&
    (opts.ad == null || r.ad === opts.ad))
}

// Which route the router would actually use for destIp — for asserting that a
// floating static stays out of the way while the primary path is up.
export function routeVia(net, devId, destIp) {
  const dev = net.devices[devId]
  if (!dev) return null
  const r = routeLookup(net, dev, destIp)
  return r ? { proto: r.proto, nextHop: r.nextHop || null, ad: r.ad } : null
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

// --- Security checks ---------------------------------------------------------

import { aclPermits } from './l3.js'

export function hasEnableSecret(net, devId) {
  return !!net.devices[devId]?.enableSecret
}

// A line (console/vty) is secured with a password and login checking.
export function lineSecured(net, devId, type) {
  const l = net.devices[devId]?.lines?.[type]
  return !!(l && l.password && l.login)
}

export function servicePwEncryption(net, devId) {
  return net.devices[devId]?.servicePasswordEncryption === true
}

// ACL logically permits / blocks a source (dst optional for extended).
export function aclAllows(net, devId, aclId, srcIp, dstIp = '0.0.0.0') {
  return aclPermits(net.devices[devId], aclId, srcIp, dstIp)
}
export function aclBlocks(net, devId, aclId, srcIp, dstIp = '0.0.0.0') {
  return !aclPermits(net.devices[devId], aclId, srcIp, dstIp)
}

export function portSecured(net, devId, ifaceName, opts = {}) {
  const d = net.devices[devId]
  const i = d && d.interfaces[canonicalIface(ifaceName)]
  const ps = i && i.portSecurity
  if (!ps || !ps.enabled) return false
  if (opts.maximum != null && ps.maximum !== opts.maximum) return false
  if (opts.sticky && !ps.sticky) return false
  if (opts.violation && ps.violation !== opts.violation) return false
  return true
}

export function dhcpSnoopingOn(net, devId, vlan = null) {
  const s = net.devices[devId]?.dhcpSnooping
  return !!(s?.enabled && (vlan == null || s.vlans.includes(vlan)))
}

export function arpInspectionOn(net, devId, vlan = null) {
  const a = net.devices[devId]?.arpInspection
  return !!(a && (vlan == null || a.vlans.includes(vlan)))
}

export function ifaceTrusted(net, devId, ifaceName, kind) {
  const d = net.devices[devId]
  const i = d && d.interfaces[canonicalIface(ifaceName)]
  if (!i) return false
  return kind === 'dhcp' ? i.dhcpSnoopTrust === true : i.arpInspectTrust === true
}

// --- Addressing checks (IPv4 + IPv6) -----------------------------------------

// Interface has exactly this IPv4 address+mask and is up.
export function ifaceHasIp(net, devId, ifaceName, ip, mask) {
  const d = net.devices[devId]
  const i = d && d.interfaces[canonicalIface(ifaceName)]
  return !!(i && i.ip === ip && i.mask === mask && !i.shutdown)
}

import { normIpv6, pingIpv6, splitPrefix, netV6, ipv6ToBig, routeLookupV6 } from './ipv6.js'

// Interface carries this IPv6 address (any prefix length match on the address).
// Interface carries this IPv6 address. If `addr` names a prefix length, that
// must match too — blueprint 1.8 is "IPv6 addressing and prefix", so a /48 is
// not an acceptable answer to a task that asked for a /64.
export function ifaceHasIpv6(net, devId, ifaceName, addr) {
  const d = net.devices[devId]
  const i = d && d.interfaces[canonicalIface(ifaceName)]
  if (!i || i.shutdown) return false
  const [wantAddr, wantLen] = String(addr).split('/')
  const target = normIpv6(wantAddr)
  return (i.ipv6 || []).some(a => {
    const [gotAddr, gotLen] = String(a).split('/')
    if (normIpv6(gotAddr) !== target) return false
    return wantLen == null || String(gotLen) === String(wantLen)
  })
}

export function ipv6PingWorks(net, srcDevId, target) {
  return pingIpv6(net, srcDevId, target).ok
}

// A configured IPv6 static route with this exact prefix/length, optionally
// pinned to a next hop — the mirror of hasStaticRoute() for IPv4.
export function hasIpv6Route(net, devId, spec, opts = {}) {
  const want = splitPrefix(spec)
  if (!want) return false
  const wantNet = netV6(want.addr, want.len)
  return (net.devices[devId]?.ipv6Routes || []).some(r =>
    r.len === want.len && netV6(r.prefixBig, r.len) === wantNet &&
    (opts.nextHop == null ||
      ipv6ToBig(r.nextHop) === ipv6ToBig(opts.nextHop)) &&
    (opts.ad == null || r.ad === opts.ad))
}

// Which IPv6 route the device would actually use for `target`.
export function ipv6RouteVia(net, devId, target) {
  const dev = net.devices[devId]
  const big = ipv6ToBig(String(target).split('/')[0])
  if (!dev || big === null) return null
  const r = routeLookupV6(net, dev, big)
  return r ? { proto: r.proto, nextHop: r.nextHop || null, len: r.len, ad: r.ad } : null
}

export function ipv6RoutingOn(net, devId) {
  return net.devices[devId]?.ipv6Routing === true
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

// Port belongs to channel-group `id`. Pass { protocol: 'lacp' } when the task
// names a protocol — otherwise `mode on` (static bundling, no negotiation at
// all) would satisfy a task that asks for LACP.
export function portInChannel(net, devId, ifaceName, id, opts = {}) {
  const d = net.devices[devId]
  const ifc = d && d.interfaces[canonicalIface(ifaceName)]
  if (!ifc || !ifc.channelGroup || ifc.channelGroup.id !== id) return false
  if (opts.protocol === 'lacp') {
    return ifc.channelGroup.mode === 'active' || ifc.channelGroup.mode === 'passive'
  }
  return true
}

export function channelUp(net, devId, id) {
  return etherchannelUp(net, devId, id)
}

// The operator has run a given show command on this device. Use it to gate a
// "Verify: ..." task so it can't pass on config alone — the learner has to look
// at the output, like they would on the exam. Pass an array when more than one
// command legitimately verifies the same thing (any one of them counts).
//
// Deliberately never keyed on `running-config`: learners run show run constantly
// while configuring, so accepting it would let a verify task pass by accident —
// the exact bug this gate exists to prevent.
export function observedShow(net, devId, key) {
  const dev = net.devices[devId]
  const keys = Array.isArray(key) ? key : [key]
  return keys.some(k => hasObserved(dev, k))
}

// This device has pinged this exact target at least once, successfully or not.
// Pair it with pingWorks()/!pingWorks() so a reachability step needs the ping to
// have actually been sent, not merely to be possible.
export function observedPing(net, devId, target) {
  return hasObserved(net.devices[devId], `ping ${String(target).toLowerCase()}`)
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

// Returns the access VLAN only when the port was *explicitly* made an access
// port. Switch ports start in access mode internally, so without the
// modeExplicit check `switchport access vlan X` alone would satisfy a task that
// asks for both commands.
export function portAccessVlan(net, devId, ifaceName) {
  const d = net.devices[devId]
  if (!d) return null
  const ifc = d.interfaces[canonicalIface(ifaceName)]
  if (!ifc || ifc.mode !== 'access' || !ifc.modeExplicit) return null
  return ifc.accessVlan || 1
}

// Native VLAN on a trunk port. Untagged frames ride this VLAN, and IOS defaults
// it to 1 — hence the fallback, which matches what show interfaces trunk prints.
export function trunkNativeVlan(net, devId, ifaceName) {
  const d = net.devices[devId]
  if (!d) return null
  const ifc = d.interfaces[canonicalIface(ifaceName)]
  if (!ifc || ifc.mode !== 'trunk') return null
  return ifc.trunkNativeVlan || 1
}

export function portIsTrunk(net, devId, ifaceName) {
  const d = net.devices[devId]
  if (!d) return false
  const ifc = d.interfaces[canonicalIface(ifaceName)]
  return !!(ifc && ifc.mode === 'trunk' && !ifc.shutdown)
}
