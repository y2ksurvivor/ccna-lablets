// Show output is checked against real IOS, because a simulator that prints
// almost-right output teaches almost-right expectations. Each case here is a
// place where ours diverged.

import { describe, it, expect } from 'vitest'
import { getScenario } from '../src/scenarios/index.js'
import { linkLocalFromMac } from '../src/engine/show.js'

const out = (id, dev, setup, cmd) => {
  const cli = getScenario(id).build().consoles[dev]
  for (const c of setup) cli.execute(c)
  return cli.execute(cmd)
}

describe('show ip route', () => {
  const routed = () => out('static-routing', 'R1',
    ['enable', 'conf t', 'ip route 0.0.0.0 0.0.0.0 10.1.12.2', 'end'], 'show ip route')

  it('marks a default route as a candidate default with *', () => {
    expect(routed().join('\n')).toMatch(/^S\*\s+0\.0\.0\.0\/0 \[1\/0\] via 10\.1\.12\.2$/m)
  })

  it('uses full interface names, not abbreviations', () => {
    const text = routed().join('\n')
    expect(text).toContain('directly connected, GigabitEthernet0/1')
    expect(text).not.toMatch(/connected, Gi0\//)
  })

  it('groups subnets under their classful major network', () => {
    const text = routed().join('\n')
    expect(text).toMatch(/^ {6}10\.0\.0\.0\/8 is variably subnetted, 2 subnets, 2 masks$/m)
    expect(text).toMatch(/^C {8}10\.1\.12\.0\/30 is directly connected, GigabitEthernet0\/1$/m)
  })

  it('emits an L host route for each connected interface address', () => {
    expect(routed().join('\n'))
      .toMatch(/^L {8}10\.1\.12\.1\/32 is directly connected, GigabitEthernet0\/1$/m)
  })

  it('indents grouped routes further than margin routes', () => {
    const rows = routed().filter(l => /^[A-Z]/.test(l))
    // A default sits at the margin (code padded to 6); group members to 9.
    const margin = rows.filter(l => l.startsWith('S*')).map(l => l.search(/\d/))
    const grouped = rows.filter(l => /^[CL] /.test(l)).map(l => l.search(/\d/))
    expect(new Set(margin)).toEqual(new Set([6]))
    expect(new Set(grouped)).toEqual(new Set([9]))
  })

  it('prints a lone classful route at the margin with no header', () => {
    const text = out('static-routing', 'R2', ['enable', 'conf t',
      'ip route 192.168.1.0 255.255.255.0 10.1.12.1', 'end'], 'show ip route').join('\n')
    expect(text).toMatch(/^S {5}192\.168\.1\.0\/24 \[1\/0\] via 10\.1\.12\.1$/m)
    expect(text).not.toMatch(/192\.168\.1\.0\/24 is (variably )?subnetted/)
  })

  it('does not duplicate a /32 loopback as both C and L', () => {
    const text = out('ospf', 'R1', ['enable', 'conf t', 'interface loopback 0',
      'ip address 1.1.1.1 255.255.255.255', 'end'], 'show ip route').join('\n')
    expect(text).toMatch(/^C {8}1\.1\.1\.1\/32 is directly connected, Loopback0$/m)
    expect(text).not.toMatch(/^L {8}1\.1\.1\.1\/32/m)
  })

  it('lists L - local in the codes block', () => {
    expect(routed()[0]).toContain('L - local')
  })
})

describe('show access-lists', () => {
  const lists = () => out('acl', 'R1', ['enable', 'conf t',
    'access-list 10 deny host 192.168.1.20', 'access-list 10 permit any',
    'access-list 100 permit ip host 192.168.1.10 host 192.168.2.100', 'end'], 'show access-lists')

  it('prints a standard host entry as a bare address', () => {
    // IOS drops the "host" keyword here, though it keeps it in running-config.
    expect(lists().join('\n')).toMatch(/^ {4}10 deny {3}192\.168\.1\.20$/m)
  })

  it('keeps host on extended entries, where IOS does', () => {
    expect(lists().join('\n')).toContain('permit ip host 192.168.1.10 host 192.168.2.100')
  })

  it('running-config still uses the configuration form', () => {
    const cfg = out('acl', 'R1', ['enable', 'conf t',
      'access-list 10 deny host 192.168.1.20', 'end'], 'show running-config').join('\n')
    expect(cfg).toContain('access-list 10 deny host 192.168.1.20')
  })
})

describe('show port-security', () => {
  const ps = () => out('l2-security', 'SW1', ['enable', 'conf t', 'interface gi0/1',
    'switchport port-security', 'switchport port-security maximum 1', 'end'], 'show port-security')

  it('title-cases the violation action', () => {
    expect(ps().join('\n')).toMatch(/Shutdown/)
    expect(ps().join('\n')).not.toMatch(/ shutdown$/m)
  })

  it('closes with the system totals IOS prints', () => {
    const text = ps().join('\n')
    expect(text).toContain('Total Addresses in System (excluding one mac per port)     : 0')
    expect(text).toContain('Max Addresses limit in System (excluding one mac per port) : 4096')
  })
})

describe('IPv6 interface brief', () => {
  const brief = () => out('ipv6-addressing', 'R1', ['enable', 'conf t', 'interface gi0/0',
    'ipv6 address 2001:DB8:ACAD:1::1/64', 'no shutdown', 'end'], 'show ipv6 interface brief')

  it('lists the link-local address before the global one', () => {
    const lines = brief()
    const ll = lines.findIndex(l => l.includes('FE80::'))
    const global = lines.findIndex(l => l.includes('2001:DB8:ACAD:1::1'))
    expect(ll).toBeGreaterThan(-1)
    expect(ll).toBeLessThan(global)
  })

  it('shows up/up for an interface that only has an IPv6 address', () => {
    // Line protocol is a layer-2 state; it does not depend on having an IPv4
    // address, which is what previously forced these interfaces to read down.
    expect(brief()[0]).toMatch(/\[up\/up\]$/)
  })

  it.each([
    ['0050.5600.0100', 'FE80::250:56FF:FE00:100'],
    ['aabb.cc00.0100', 'FE80::A8BB:CCFF:FE00:100'],
  ])('derives %s by modified EUI-64', (mac, expected) => {
    expect(linkLocalFromMac(mac)).toBe(expected)
  })
})

describe('show ip interface brief', () => {
  it('reports up/up for an IPv6-only interface', () => {
    const text = out('ipv6-addressing', 'R1', ['enable', 'conf t', 'interface gi0/0',
      'ipv6 address 2001:DB8:ACAD:1::1/64', 'no shutdown', 'end'],
    'show ip interface brief').join('\n')
    expect(text).toMatch(/GigabitEthernet0\/0 +unassigned +YES unset +up +up/)
  })
})
