// Device state model.
// A device (router or switch) holds the live state that commands mutate and
// that `show` commands render from. This is the single source of truth — the
// grader inspects this object, never the user's keystrokes.

let idCounter = 0
let macCounter = 0

// Deterministic MAC so scenarios are reproducible (no Math.random).
export function nextMac() {
  macCounter += 1
  const n = macCounter
  const hex = n.toString(16).padStart(4, '0')
  return `0050.56${hex.slice(0, 2)}.${hex.slice(2)}${hex.slice(0, 2)}`
}

export function resetCounters() {
  idCounter = 0
  macCounter = 0
}

// A host/PC endpoint. Not a full IOS device — just enough to originate pings
// and answer ARP/ICMP so connectivity lablets can be graded and verified.
export function createHost(opts = {}) {
  return {
    id: opts.id || `host${++idCounter}`,
    kind: 'host',
    hostname: opts.hostname || 'PC',
    mac: opts.mac || nextMac(),
    ip: opts.ip || null,
    mask: opts.mask || null,
    gateway: opts.gateway || null,
    // The single NIC name hosts present, for link wiring.
    nic: opts.nic || 'NIC',
    // See createDevice().observed — hosts record `ipconfig` the same way.
    observed: {},
  }
}

export function createDevice(opts = {}) {
  const kind = opts.kind || 'router' // 'router' | 'switch'
  return {
    id: opts.id || `dev${++idCounter}`,
    kind,
    hostname: opts.hostname || (kind === 'switch' ? 'Switch' : 'Router'),
    // Interfaces keyed by canonical name, e.g. "GigabitEthernet0/0".
    interfaces: {},
    // Discovery protocols. CDP runs by default; LLDP is off until `lldp run`.
    cdpEnabled: true,
    lldpEnabled: false,
    // EtherChannel: id -> { id, members: [ifaceName] }
    portChannels: {},
    // L2 (switch) state
    vlans: kind === 'switch' ? { 1: { id: 1, name: 'default' } } : {},
    macTable: {}, // mac -> { iface, vlan }
    // L3 state
    routes: [], // static routes: { proto, prefix, mask, nextHop, ad, metric }
    ospf: null, // { pid, routerId, networks: [{ip, wildcard, area}], passive: [] }
    ipv6Routing: false, // ipv6 unicast-routing
    // IPv6 static routes: { prefix, len, nextHop, prefixBig, ad }
    ipv6Routes: [],
    arp: {}, // ip -> mac
    // Global config
    enableSecret: null,
    enablePassword: null,
    servicePasswordEncryption: false,
    lines: { console: {}, vty: {} },
    banner: null,
    // Layer 2 security (5.7): DHCP snooping + dynamic ARP inspection
    dhcpSnooping: { enabled: false, vlans: [] },
    arpInspection: { vlans: [] },
    // Remote access / SSH (4.8)
    domainName: null,
    rsaKey: null, // { modulus }
    users: [], // [{ name, secret }]
    // NTP (4.2)
    ntp: { master: false, stratum: 8, servers: [] },
    // DHCP (4.6): server pools + globally excluded addresses
    dhcpPools: {}, // name -> { network, mask, defaultRouter, dnsServer }
    dhcpExcluded: [], // [ip]
    // NAT (4.1)
    nat: { statics: [], pools: {}, insideSourceLists: [] },
    acls: {}, // id -> [{ action, src, wildcard }]  (minimal, for NAT source lists)
    // Runtime. savedConfig is a snapshot of running-config taken at the last
    // write/copy; null means "never saved". The grader compares it to the
    // current running-config to know whether unsaved changes exist.
    savedConfig: null,
    // Canonical names of show commands the operator has run on this device, e.g.
    // 'etherchannel summary'. Lets a "Verify: ..." task require that the learner
    // actually looked at the output, not just that the config happens to be
    // right. Still device state — the grader never reads keystrokes.
    observed: {},
  }
}

// Record that a show command ran on this device. `key` is the canonical,
// unabbreviated command name (see observe() calls in cli.js).
export function observe(dev, key) {
  if (!dev) return
  if (!dev.observed) dev.observed = {}
  dev.observed[key] = (dev.observed[key] || 0) + 1
}

// IOS logs interface state changes to the console. Timestamps count from a
// per-device boot clock that advances a second per message, so output stays
// deterministic (no wall clock) while still looking like a real log line.
export function logIfaceState(dev, ifc, wasShut, hadProto) {
  const out = []
  if (!dev || !ifc) return out
  const stamp = () => {
    dev.logSeconds = (dev.logSeconds ?? 0) + 1
    const s = dev.logSeconds
    const mm = String(Math.floor(s / 60)).padStart(2, '0')
    const ss = String(s % 60).padStart(2, '0')
    return `*Mar  1 00:${mm}:${ss}.000:`
  }
  if (wasShut !== ifc.shutdown) {
    out.push(ifc.shutdown
      // Admin-down is LINK-5-CHANGED; coming up is LINK-3-UPDOWN.
      ? `${stamp()} %LINK-5-CHANGED: Interface ${ifc.name}, changed state to administratively down`
      : `${stamp()} %LINK-3-UPDOWN: Interface ${ifc.name}, changed state to up`)
  }
  const proto = !!ifc.lineProtocol && !ifc.shutdown
  if (!!hadProto !== proto) {
    out.push(`${stamp()} %LINEPROTO-5-UPDOWN: Line protocol on Interface ${ifc.name}, changed state to ${proto ? 'up' : 'down'}`)
  }
  return out
}

// Record traffic across an interface. `dir` is 'in' or 'out'.
export function countTraffic(ifc, dir, packets, bytes) {
  const c = ifc && ifc.counters
  if (!c) return
  if (dir === 'in') { c.inPackets += packets; c.inBytes += bytes }
  else { c.outPackets += packets; c.outBytes += bytes }
}

export function hasObserved(dev, key) {
  return !!dev && (dev.observed?.[key] || 0) > 0
}

// Interface helpers -----------------------------------------------------------

export function getInterface(dev, name) {
  const canon = canonicalIface(name)
  if (!canon) return null
  if (!dev.interfaces[canon]) {
    dev.interfaces[canon] = {
      name: canon,
      shortName: shortIface(canon),
      mac: nextMac(),
      ip: null,
      mask: null,
      ipv6: [], // ['2001:db8:acad:1::1/64', ...]
      // Switch access ports come up by default; router ports are admin-down.
      shutdown: dev.kind !== 'switch',
      description: null,
      // switchport
      mode: dev.kind === 'switch' ? 'access' : null, // 'access' | 'trunk'
      // Whether `switchport mode ...` was actually issued. Real switch ports
      // default to dynamic negotiation, not hard access, so "left at the
      // default" and "explicitly configured as access" are different states —
      // and only the second should satisfy a task or appear in show run.
      modeExplicit: false,
      accessVlan: dev.kind === 'switch' ? 1 : null,
      trunkNativeVlan: dev.kind === 'switch' ? 1 : null,
      trunkAllowed: 'all', // 'all' | array of vlan ids
      // discovery protocols (per-interface)
      cdpEnabled: true,
      lldpTx: true,
      lldpRx: true,
      // etherchannel membership: null | { id, mode: 'active'|'passive'|'on' }
      channelGroup: null,
      // IP services
      natRole: null, // null | 'inside' | 'outside'
      helperAddress: null, // DHCP relay target
      addressMode: 'static', // 'static' | 'dhcp' (ip address dhcp)
      // Security
      accessGroupIn: null, // ACL id applied inbound
      accessGroupOut: null, // ACL id applied outbound
      portSecurity: null, // { enabled, maximum, violation, sticky }
      dhcpSnoopTrust: false,
      arpInspectTrust: false,
      // link
      connected: false, // set true when a link is attached
      lineProtocol: false,
      // Traffic and error counters, as `show interfaces` reports them. The
      // in/out figures move as pings traverse the interface; the error fields
      // stay zero unless a scenario seeds them (blueprint 1.4 asks the learner
      // to spot collisions, CRC and duplex problems in this output).
      counters: {
        inPackets: 0, inBytes: 0, inBroadcasts: 0,
        outPackets: 0, outBytes: 0,
        runts: 0, giants: 0, throttles: 0,
        inErrors: 0, crc: 0, frame: 0, overrun: 0, ignored: 0,
        outErrors: 0, collisions: 0, lateCollision: 0, deferred: 0,
        interfaceResets: 0, lostCarrier: 0, noCarrier: 0, babbles: 0,
      },
    }
  }
  return dev.interfaces[canon]
}

// Normalize "gi0/0", "g0/0", "GigabitEthernet0/0" -> "GigabitEthernet0/0"
const IFACE_TYPES = [
  ['GigabitEthernet', ['gigabitethernet', 'gig', 'gi', 'g']],
  ['FastEthernet', ['fastethernet', 'fa', 'f']],
  ['Ethernet', ['ethernet', 'eth', 'e']],
  ['Serial', ['serial', 'se', 's']],
  ['Loopback', ['loopback', 'lo', 'l']],
  ['Vlan', ['vlan', 'vl']],
]

export function canonicalIface(name) {
  if (!name) return null
  const m = String(name).trim().match(/^([a-zA-Z]+)\s*([\d/.]+)$/)
  if (!m) return null
  const [, rawType, num] = m
  const lower = rawType.toLowerCase()
  for (const [canon, aliases] of IFACE_TYPES) {
    if (aliases.includes(lower) || canon.toLowerCase() === lower) {
      return `${canon}${num}`
    }
  }
  return null
}

export function shortIface(canon) {
  const m = canon.match(/^([a-zA-Z]+)([\d/.]+)$/)
  if (!m) return canon
  const [, type, num] = m
  const map = {
    GigabitEthernet: 'Gi',
    FastEthernet: 'Fa',
    Ethernet: 'Et',
    Serial: 'Se',
    Loopback: 'Lo',
    Vlan: 'Vl',
  }
  return `${map[type] || type.slice(0, 2)}${num}`
}
