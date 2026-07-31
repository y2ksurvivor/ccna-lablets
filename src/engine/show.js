// Renderers for `show` commands. Each reads device state and produces the
// text IOS would print. Keeping these pure (state -> lines) makes them easy to
// test and keeps the command handlers small.

import { discoveryNeighbors, etherchannelUp } from './network.js'
import { getInterface } from './device.js'

export function renderRunningConfig(dev) {
  const out = ['Building configuration...', '', 'Current configuration:', '!']
  out.push(`hostname ${dev.hostname}`, '!')
  if (dev.enableSecret) out.push(`enable secret ${dev.enableSecret}`, '!')
  if (dev.lldpEnabled) out.push('lldp run', '!')
  if (dev.cdpEnabled === false) out.push('no cdp run', '!')

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
    }
    if (ifc.ip) out.push(` ip address ${ifc.ip} ${ifc.mask}`)
    if (ifc.channelGroup) out.push(` channel-group ${ifc.channelGroup.id} mode ${ifc.channelGroup.mode}`)
    if (ifc.cdpEnabled === false) out.push(' no cdp enable')
    if (ifc.shutdown) out.push(' shutdown')
    out.push('!')
  }

  for (const r of dev.routes) {
    out.push(`ip route ${r.prefix} ${r.mask} ${r.nextHop}`)
  }
  if (dev.routes.length) out.push('!')

  out.push('end')
  return out
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
