// Renderers for `show` commands. Each reads device state and produces the
// text IOS would print. Keeping these pure (state -> lines) makes them easy to
// test and keeps the command handlers small.

import { discoveryNeighbors, etherchannelUp } from './network.js'
import { getInterface, canonicalIface } from './device.js'
import { routingTable, ospfNeighbors, maskToLen } from './l3.js'
import { ntpSynced, natTranslations } from './ipservices.js'

export function renderRunningConfig(dev) {
  const out = ['Building configuration...', '', 'Current configuration:', '!']
  if (dev.servicePasswordEncryption) out.push('service password-encryption', '!')
  out.push(`hostname ${dev.hostname}`, '!')
  if (dev.ipv6Routing) out.push('ipv6 unicast-routing', '!')
  if (dev.enableSecret) out.push(`enable secret ${dev.enableSecret}`)
  if (dev.enablePassword) out.push(`enable password ${dev.enablePassword}`)
  if (dev.enableSecret || dev.enablePassword) out.push('!')
  if (dev.dhcpSnooping?.enabled) { out.push('ip dhcp snooping'); if (dev.dhcpSnooping.vlans.length) out.push(`ip dhcp snooping vlan ${dev.dhcpSnooping.vlans.join(',')}`); out.push('!') }
  if (dev.arpInspection?.vlans.length) out.push(`ip arp inspection vlan ${dev.arpInspection.vlans.join(',')}`, '!')
  for (const u of (dev.users || [])) out.push(`username ${u.name} secret ${u.secret}`)
  if ((dev.users || []).length) out.push('!')
  if (dev.domainName) out.push(`ip domain-name ${dev.domainName}`, '!')
  if (dev.rsaKey) out.push(`! crypto key rsa ${dev.rsaKey.modulus} bits generated`, '!')
  if (dev.lldpEnabled) out.push('lldp run', '!')
  if (dev.cdpEnabled === false) out.push('no cdp run', '!')
  // DHCP pools
  for (const p of Object.values(dev.dhcpPools || {})) {
    out.push(`ip dhcp pool ${p.name}`)
    if (p.network) out.push(` network ${p.network} ${p.mask || ''}`.trimEnd())
    if (p.defaultRouter) out.push(` default-router ${p.defaultRouter}`)
    if (p.dnsServer) out.push(` dns-server ${p.dnsServer}`)
    out.push('!')
  }
  for (const e of (dev.dhcpExcluded || [])) out.push(`ip dhcp excluded-address ${e}`)

  if (dev.kind === 'switch') {
    const vlans = Object.values(dev.vlans).filter(v => v.id !== 1)
    for (const v of vlans) {
      out.push(`vlan ${v.id}`, ` name ${v.name}`, '!')
    }
  }

  for (const ifc of Object.values(dev.interfaces)) {
    out.push(`interface ${ifc.name}`)
    if (ifc.description) out.push(` description ${ifc.description}`)
    if (dev.kind === 'switch') {
      if (ifc.mode === 'trunk') {
        if (ifc.trunkNativeVlan && ifc.trunkNativeVlan !== 1) out.push(` switchport trunk native vlan ${ifc.trunkNativeVlan}`)
        if (Array.isArray(ifc.trunkAllowed)) out.push(` switchport trunk allowed vlan ${ifc.trunkAllowed.join(',')}`)
        out.push(' switchport mode trunk')
      } else if (ifc.mode === 'access') {
        if (ifc.accessVlan && ifc.accessVlan !== 1) out.push(` switchport access vlan ${ifc.accessVlan}`)
        out.push(' switchport mode access')
      }
      if (ifc.portSecurity?.enabled) {
        out.push(' switchport port-security')
        if (ifc.portSecurity.maximum && ifc.portSecurity.maximum !== 1) out.push(` switchport port-security maximum ${ifc.portSecurity.maximum}`)
        if (ifc.portSecurity.sticky) out.push(' switchport port-security mac-address sticky')
        if (ifc.portSecurity.violation && ifc.portSecurity.violation !== 'shutdown') out.push(` switchport port-security violation ${ifc.portSecurity.violation}`)
      }
      if (ifc.dhcpSnoopTrust) out.push(' ip dhcp snooping trust')
      if (ifc.arpInspectTrust) out.push(' ip arp inspection trust')
    }
    if (ifc.addressMode === 'dhcp') out.push(' ip address dhcp')
    else if (ifc.ip) out.push(` ip address ${ifc.ip} ${ifc.mask}`)
    for (const a of (ifc.ipv6 || [])) out.push(` ipv6 address ${a}`)
    if (ifc.natRole) out.push(` ip nat ${ifc.natRole}`)
    if (ifc.helperAddress) out.push(` ip helper-address ${ifc.helperAddress}`)
    if (ifc.accessGroupIn) out.push(` ip access-group ${ifc.accessGroupIn} in`)
    if (ifc.accessGroupOut) out.push(` ip access-group ${ifc.accessGroupOut} out`)
    if (ifc.channelGroup) out.push(` channel-group ${ifc.channelGroup.id} mode ${ifc.channelGroup.mode}`)
    if (ifc.cdpEnabled === false) out.push(' no cdp enable')
    if (ifc.shutdown) out.push(' shutdown')
    out.push('!')
  }

  if (dev.ospf) {
    out.push(`router ospf ${dev.ospf.pid}`)
    if (dev.ospf.routerId) out.push(` router-id ${dev.ospf.routerId}`)
    for (const n of dev.ospf.networks) out.push(` network ${n.ip} ${n.wildcard} area ${n.area}`)
    for (const p of (dev.ospf.passive || [])) out.push(` passive-interface ${p}`)
    out.push('!')
  }

  // NAT
  if (dev.nat) {
    for (const p of Object.values(dev.nat.pools)) {
      out.push(`ip nat pool ${p.name} ${p.start} ${p.end}${p.mask ? ' netmask ' + p.mask : ''}`)
    }
    for (const s of dev.nat.statics) out.push(`ip nat inside source static ${s.insideLocal} ${s.insideGlobal}`)
    for (const l of dev.nat.insideSourceLists) out.push(`ip nat inside source list ${l.acl} pool ${l.pool}${l.overload ? ' overload' : ''}`)
    if (dev.nat.pools && (Object.keys(dev.nat.pools).length || dev.nat.statics.length || dev.nat.insideSourceLists.length)) out.push('!')
  }
  // ACLs
  for (const [id, entries] of Object.entries(dev.acls || {})) {
    for (const e of entries) out.push(`access-list ${id} ${renderAclEntry(e)}`)
  }
  // Static routes
  for (const r of dev.routes) {
    out.push(`ip route ${r.prefix} ${r.mask} ${r.nextHop}${r.ad && r.ad !== 1 ? ' ' + r.ad : ''}`)
  }
  if (dev.routes.length) out.push('!')
  // NTP
  if (dev.ntp?.master) out.push(`ntp master ${dev.ntp.stratum}`)
  for (const s of (dev.ntp?.servers || [])) out.push(`ntp server ${s}`)
  // Lines
  const con = dev.lines?.console
  if (con && (con.login || con.password)) {
    out.push('line con 0')
    if (con.password) out.push(` password ${con.password}`)
    if (con.login) out.push(con.login === 'local' ? ' login local' : ' login')
    out.push('!')
  }
  const vty = dev.lines?.vty
  if (vty && (vty.transportInput || vty.login || vty.password)) {
    out.push('line vty 0 4')
    if (vty.password) out.push(` password ${vty.password}`)
    if (vty.login) out.push(vty.login === 'local' ? ' login local' : ' login')
    if (vty.transportInput) out.push(` transport input ${vty.transportInput.join(' ')}`)
    out.push('!')
  }

  out.push('end')
  return out
}

function aclAddr(a) {
  if (!a || a.any) return 'any'
  if (!a.wildcard || a.wildcard === '0.0.0.0') return `host ${a.ip}`
  return `${a.ip} ${a.wildcard}`
}

function renderAclEntry(e) {
  if (e.kind === 'extended') return `${e.action} ${e.proto} ${aclAddr(e.src)} ${aclAddr(e.dst)}`
  return `${e.action} ${aclAddr(e.src)}`
}

export function renderIpIntBrief(dev) {
  const rows = [['Interface', 'IP-Address', 'OK?', 'Method', 'Status', 'Protocol']]
  for (const ifc of Object.values(dev.interfaces)) {
    const status = ifc.shutdown ? 'administratively down' : (ifc.lineProtocol ? 'up' : 'down')
    const proto = ifc.lineProtocol && !ifc.shutdown ? 'up' : 'down'
    rows.push([
      ifc.shortName,
      ifc.ip || 'unassigned',
      'YES',
      ifc.ip ? 'manual' : 'unset',
      status,
      proto,
    ])
  }
  return formatColumns(rows)
}

// show interfaces [name] — the long form. Same status wording as the brief
// table, plus the per-interface detail the brief view leaves out.
export function renderInterfaces(dev, filter = null) {
  // The caller validates the name (so a bad one gets IOS's caret error); by here
  // the filter either names a real interface or is absent.
  const wanted = filter ? canonicalIface(filter) : null
  const list = Object.values(dev.interfaces).filter(i => !wanted || i.name === wanted)
  const out = []
  for (const ifc of list) {
    const status = ifc.shutdown ? 'administratively down' : (ifc.lineProtocol ? 'up' : 'down')
    const proto = ifc.lineProtocol && !ifc.shutdown ? 'up' : 'down'
    out.push(`${ifc.name} is ${status}, line protocol is ${proto}`)
    out.push(`  Hardware is Gigabit Ethernet, address is ${ifc.mac}`)
    if (ifc.description) out.push(`  Description: ${ifc.description}`)
    out.push(ifc.ip
      ? `  Internet address is ${ifc.ip}/${maskToLen(ifc.mask)}`
      : '  Internet address is not set')
    for (const a of (ifc.ipv6 || [])) out.push(`  IPv6 address is ${a}`)
    out.push('  MTU 1500 bytes, BW 1000000 Kbit/sec, DLY 10 usec')
    out.push('  Encapsulation ARPA, loopback not set')
    out.push('  Full-duplex, 1000Mb/s, media type is RJ45')
  }
  return out
}

export function renderIpv6IntBrief(dev) {
  const out = []
  for (const ifc of Object.values(dev.interfaces)) {
    const status = ifc.shutdown ? 'administratively down' : (ifc.lineProtocol ? 'up' : 'down')
    const proto = ifc.lineProtocol && !ifc.shutdown ? 'up' : 'down'
    out.push(`${ifc.name.padEnd(22)} [${status}/${proto}]`)
    for (const a of (ifc.ipv6 || [])) out.push(`    ${a.split('/')[0]}`)
    if (!(ifc.ipv6 || []).length) out.push('    unassigned')
  }
  if (!out.length) out.push('(no interfaces)')
  return out
}

export function renderVlanBrief(dev) {
  if (dev.kind !== 'switch') return ['% This command is only available on switches']
  const out = ['VLAN Name                             Status    Ports', '---- -------------------------------- --------- -------------------------------']
  for (const v of Object.values(dev.vlans)) {
    const ports = Object.values(dev.interfaces)
      .filter(i => i.mode === 'access' && (i.accessVlan || 1) === v.id)
      .map(i => i.shortName)
      .join(', ')
    out.push(`${String(v.id).padEnd(4)} ${v.name.padEnd(32)} active    ${ports}`)
  }
  return out
}

// show interfaces trunk — the canonical verification for interswitch
// connectivity (blueprint 2.2): which ports are trunking, the native VLAN, and
// which VLANs are actually allowed and forwarding.
export function renderInterfacesTrunk(dev) {
  if (dev.kind !== 'switch') return ['% This command is only available on switches']
  const trunks = Object.values(dev.interfaces).filter(i => i.mode === 'trunk' && !i.shutdown)
  if (!trunks.length) return ['']

  const allowed = (i) => (i.trunkAllowed === 'all' ? '1-4094' : [...i.trunkAllowed].sort((a, b) => a - b).join(','))
  // Active = allowed on this trunk AND defined in the local VLAN database.
  const active = (i) => {
    const ids = Object.keys(dev.vlans).map(Number).sort((a, b) => a - b)
    const permitted = i.trunkAllowed === 'all' ? ids : ids.filter(v => i.trunkAllowed.includes(v))
    return permitted.length ? permitted.join(',') : 'none'
  }

  const out = ['Port        Mode         Encapsulation  Status        Native vlan']
  for (const i of trunks) {
    out.push(`${i.shortName.padEnd(11)} on           802.1q         trunking      ${i.trunkNativeVlan || 1}`)
  }
  out.push('', 'Port        Vlans allowed on trunk')
  for (const i of trunks) out.push(`${i.shortName.padEnd(11)} ${allowed(i)}`)
  out.push('', 'Port        Vlans allowed and active in management domain')
  for (const i of trunks) out.push(`${i.shortName.padEnd(11)} ${active(i)}`)
  return out
}

export function renderCdpNeighbors(dev, net, detail = false) {
  if (!net) return ['(no topology)']
  const nbrs = discoveryNeighbors(net, dev.id, 'cdp')
  if (detail) {
    if (!nbrs.length) return ['']
    const out = []
    for (const n of nbrs) {
      out.push('-------------------------')
      out.push(`Device ID: ${n.neighborName}`)
      out.push(`Platform: ${n.platform},  Capabilities: ${n.capability}`)
      out.push(`Interface: ${n.localPort},  Port ID (outgoing port): ${n.remotePort}`)
      out.push('')
    }
    return out
  }
  const out = [
    'Capability Codes: R - Router, S - Switch, H - Host',
    '',
    'Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID',
  ]
  for (const n of nbrs) {
    out.push(`${n.neighborName.padEnd(16)} ${n.localPort.padEnd(17)} 150        ${n.capability.padEnd(11)} ${'Cisco'.padEnd(9)} ${n.remotePort}`)
  }
  if (!nbrs.length) out.push('(no CDP neighbors)')
  return out
}

export function renderLldpNeighbors(dev, net) {
  if (!net) return ['(no topology)']
  const nbrs = discoveryNeighbors(net, dev.id, 'lldp')
  const out = [
    'Capability codes:',
    '    (R) Router, (B) Bridge, (S) Switch, (H) Host',
    '',
    'Device ID           Local Intf    Hold-time  Capability      Port ID',
  ]
  for (const n of nbrs) {
    out.push(`${n.neighborName.padEnd(19)} ${n.localPort.padEnd(13)} 120        ${n.capability.padEnd(15)} ${n.remotePort}`)
  }
  out.push('', `Total entries displayed: ${nbrs.length}`)
  return out
}

export function renderEtherchannelSummary(dev, net) {
  const pcs = Object.values(dev.portChannels || {})
  const out = [
    'Flags:  D - down        P - bundled in port-channel',
    '        I - stand-alone s - suspended',
    '        U - in use      f - failed to allocate aggregator',
    '',
    'Number of channel-groups in use: ' + pcs.length,
    'Number of aggregators:           ' + pcs.length,
    '',
    'Group  Port-channel  Protocol    Ports',
    '------+-------------+-----------+-----------------------------------------------',
  ]
  for (const po of pcs) {
    const up = net ? etherchannelUp(net, dev.id, po.id) : false
    const flag = up ? 'U' : 'D'
    const proto = memberProtocol(dev, po)
    const ports = po.members.map(m => {
      const ifc = getInterface(dev, m)
      const pflag = up ? 'P' : 'D'
      return `${ifc.shortName}(${pflag})`
    }).join(' ')
    out.push(`${String(po.id).padEnd(6)} Po${String(po.id).padEnd(11)} ${(proto).padEnd(11)} ${ports}`)
  }
  return out
}

export function renderIpRoute(dev, net) {
  if (dev.kind !== 'router') return ['% This command is available on routers']
  // routingTable() already installs only the best route per prefix, so a
  // higher-AD floating static stays out of the table while the primary is up.
  const table = routingTable(net, dev)
  const out = [
    'Codes: C - connected, S - static, O - OSPF, * - candidate default',
    '',
  ]
  const def = table.find(r => r.netInt === 0 && r.maskInt === 0)
  out.push(def
    ? `Gateway of last resort is ${def.nextHop || '0.0.0.0'} to network 0.0.0.0`
    : 'Gateway of last resort is not set')
  out.push('')

  table.sort((a, b) => (a.netInt >>> 0) - (b.netInt >>> 0))
  for (const r of table) {
    const len = maskToLen(r.mask)
    const prefix = `${r.prefix}/${len}`
    if (r.connected) {
      const ifc = getInterface(dev, r.iface)
      out.push(`C        ${prefix} is directly connected, ${ifc ? ifc.shortName : r.iface}`)
    } else {
      out.push(`${r.proto}        ${prefix} [${r.ad}/${r.metric}] via ${r.nextHop}`)
    }
  }
  if (table.length === 0) out.push('(routing table is empty)')
  return out
}

export function renderOspfNeighbors(dev, net) {
  if (!dev.ospf) return ['% OSPF is not running']
  const nbrs = ospfNeighbors(net, dev.id)
  const out = ['Neighbor ID     Pri   State           Dead Time   Address         Interface']
  for (const n of nbrs) {
    out.push(`${n.id.padEnd(15)} 1     FULL/BDR        00:00:35    ${n.ip.padEnd(15)} `)
  }
  if (!nbrs.length) out.push('(no OSPF neighbors — check network statements, areas, and interface state)')
  return out
}

export function renderAccessLists(dev) {
  const out = []
  for (const [id, entries] of Object.entries(dev.acls || {})) {
    const type = parseInt(id, 10) <= 99 ? 'Standard' : 'Extended'
    out.push(`${type} IP access list ${id}`)
    entries.forEach((e, i) => out.push(`    ${(i + 1) * 10} ${renderAclEntry(e)}`))
  }
  if (!out.length) out.push('(no access lists configured)')
  return out
}

export function renderPortSecurity(dev) {
  const out = [
    'Secure Port  MaxSecureAddr  CurrentAddr  SecurityViolation  Security Action',
    '                 (Count)       (Count)         (Count)',
    '----------------------------------------------------------------------------',
  ]
  let any = false
  for (const ifc of Object.values(dev.interfaces)) {
    if (!ifc.portSecurity?.enabled) continue
    any = true
    out.push(`${ifc.shortName.padEnd(12)} ${String(ifc.portSecurity.maximum).padEnd(14)} 0            0                  ${ifc.portSecurity.violation}`)
  }
  if (!any) out.push('(no ports have port-security enabled)')
  return out
}

export function renderIpSsh(dev) {
  if (!dev.rsaKey) {
    return ['SSH Disabled - version 2.0', '%Please create RSA keys (of at least 768 bits) to enable SSH.']
  }
  return [
    'SSH Enabled - version 2.0',
    'Authentication methods:publickey,keyboard-interactive,password',
    'Authentication timeout: 120 secs; Authentication retries: 3',
  ]
}

export function renderNtpStatus(dev, net) {
  const synced = ntpSynced(net, dev.id)
  if (!synced) return ['Clock is unsynchronized, stratum 16, no reference clock']
  const st = dev.ntp.master ? dev.ntp.stratum : dev.ntp.stratum + 1
  const ref = dev.ntp.master ? '127.127.1.1' : (dev.ntp.servers[0] || '0.0.0.0')
  return [`Clock is synchronized, stratum ${st}, reference is ${ref}`]
}

export function renderNtpAssociations(dev, net) {
  const out = ['  address         ref clock       st   when   poll reach  delay  offset   disp',
    '=================================================================================']
  for (const s of dev.ntp.servers) {
    const good = ntpSynced(net, dev.id)
    out.push(`${good ? '*~' : ' ~'}${s.padEnd(15)} .LOCL.           8     16     64  ${good ? '377' : '  0'}   1.00    0.50   1.5`)
  }
  if (!dev.ntp.servers.length) out.push('(no NTP associations)')
  out.push(' * sys.peer, # selected, + candidate, ~ configured')
  return out
}

export function renderNatTranslations(dev, net) {
  const t = natTranslations(dev)
  const out = ['Pro  Inside global      Inside local       Outside local      Outside global']
  for (const x of t) {
    out.push(`${x.proto}  ${x.insideGlobal.padEnd(18)} ${x.insideLocal.padEnd(18)} ${x.outsideLocal.padEnd(18)} ${x.outsideGlobal}`)
  }
  if (!t.length) out.push('(no active translations)')
  return out
}

function memberProtocol(dev, po) {
  for (const m of po.members) {
    const ifc = getInterface(dev, m)
    if (ifc?.channelGroup?.mode === 'on') return '-'
    if (ifc?.channelGroup) return 'LACP'
  }
  return '-'
}

function formatColumns(rows) {
  const widths = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] || 0, String(cell).length)
    })
  }
  return rows.map(row =>
    row.map((cell, i) => String(cell).padEnd(widths[i] + 2)).join('').trimEnd()
  )
}
