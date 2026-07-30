// Device state model.
// A device (router or switch) holds the live state that commands mutate and
// that `show` commands render from. This is the single source of truth — the
// grader inspects this object, never the user's keystrokes.

let idCounter = 0

export function createDevice(opts = {}) {
  const kind = opts.kind || 'router' // 'router' | 'switch'
  return {
    id: opts.id || `dev${++idCounter}`,
    kind,
    hostname: opts.hostname || (kind === 'switch' ? 'Switch' : 'Router'),
    // Interfaces keyed by canonical name, e.g. "GigabitEthernet0/0".
    interfaces: {},
    // L2 (switch) state
    vlans: kind === 'switch' ? { 1: { id: 1, name: 'default' } } : {},
    macTable: {}, // mac -> { iface, vlan }
    // L3 state
    routes: [], // { proto, prefix, mask, nextHop, iface, ad, metric }
    arp: {}, // ip -> mac
    // Global config
    enableSecret: null,
    lines: { console: {}, vty: {} },
    banner: null,
    // Runtime
    startupConfig: null,
  }
}

// Interface helpers -----------------------------------------------------------

export function getInterface(dev, name) {
  const canon = canonicalIface(name)
  if (!canon) return null
  if (!dev.interfaces[canon]) {
    dev.interfaces[canon] = {
      name: canon,
      shortName: shortIface(canon),
      ip: null,
      mask: null,
      shutdown: true, // routers default admin-down
      description: null,
      // switchport
      mode: dev.kind === 'switch' ? 'access' : null, // 'access' | 'trunk'
      accessVlan: dev.kind === 'switch' ? 1 : null,
      trunkVlans: null,
      // link
      lineProtocol: false,
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
