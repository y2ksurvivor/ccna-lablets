// Renderers for `show` commands. Each reads device state and produces the
// text IOS would print. Keeping these pure (state -> lines) makes them easy to
// test and keeps the command handlers small.

export function renderRunningConfig(dev) {
  const out = ['Building configuration...', '', 'Current configuration:', '!']
  out.push(`hostname ${dev.hostname}`, '!')
  if (dev.enableSecret) out.push(`enable secret ${dev.enableSecret}`, '!')

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
      if (ifc.mode === 'trunk') out.push(' switchport mode trunk')
      else if (ifc.mode === 'access') {
        out.push(' switchport mode access')
        if (ifc.accessVlan && ifc.accessVlan !== 1) out.push(` switchport access vlan ${ifc.accessVlan}`)
      }
    }
    if (ifc.ip) out.push(` ip address ${ifc.ip} ${ifc.mask}`)
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
