// IOS accepts any unique prefix of any keyword, at every position — not just the
// first word. `ip add`, `sw mo acc` and `enable sec` are all legal on real gear.
// Only the leading command word used to be resolved here; every sub-keyword was
// compared exactly, so a learner typing normally hit "% Invalid input".

import { describe, it, expect } from 'vitest'
import { getScenario } from '../src/scenarios/index.js'

const run = (id, dev, setup, cmd) => {
  const cli = getScenario(id).build().consoles[dev]
  for (const c of setup) cli.execute(c)
  return cli.execute(cmd)
}
const rejected = (out) => out.length > 0 && /Invalid input|Incomplete command/.test(out.join('\n'))

const IFACE = ['enable', 'conf t', 'interface gi0/0']
const SW_PORT = ['enable', 'conf t', 'interface gi0/1']
const SW_TRUNK = ['enable', 'conf t', 'interface gi0/24']
const CONF = ['enable', 'conf t']

// [lablet, device, setup, abbreviated form]
const ABBREVIATED = [
  ['device-hardening', 'R1', CONF, 'enable sec cisco123'],
  ['device-hardening', 'R1', CONF, 'enable pass letmein'],
  ['ipv4-addressing', 'R1', IFACE, 'ip addr 10.0.0.1 255.255.255.0'],
  ['ipv4-addressing', 'R1', IFACE, 'ip add 10.0.0.1 255.255.255.0'],
  ['vlan-basics', 'SW1', SW_PORT, 'switchport mode acc'],
  ['vlan-basics', 'SW1', SW_PORT, 'sw mo acc'],
  ['vlan-basics', 'SW1', SW_PORT, 'switchport acc vlan 10'],
  ['vlan-basics', 'SW1', SW_TRUNK, 'switchport mode tr'],
  ['vlan-basics', 'SW1', SW_TRUNK, 'switchport trunk nat vlan 99'],
  ['static-routing', 'R1', CONF, 'ip rou 0.0.0.0 0.0.0.0 10.1.12.2'],
  ['ssh', 'R1', CONF, 'ip dom lab.local'],
  ['ssh', 'R1', CONF, 'ip domain name lab.local'],
  ['ssh', 'R1', [...CONF, 'line vty 0 4'], 'transport in ssh'],
  ['ssh', 'R1', [...CONF, 'line vty 0 4'], 'login loc'],
  ['nat', 'R1', IFACE, 'ip nat ins'],
  ['nat', 'R1', CONF, 'ip nat ins sou stat 192.168.1.10 203.0.113.10'],
  ['dhcp', 'R1', IFACE, 'ip help 10.0.12.2'],
  ['dhcp', 'R2', CONF, 'ip dhcp poo LAN1'],
  ['l2-security', 'SW1', SW_PORT, 'switchport port-sec max 1'],
  ['l2-security', 'SW1', SW_PORT, 'switchport port-sec mac stick'],
  ['l2-security', 'SW1', ['enable', 'conf t', 'interface gi0/24'], 'ip dhcp snoop tru'],
  ['acl', 'R1', ['enable', 'conf t', 'interface gi0/1'], 'ip access-g 10 out'],
  ['ipv6-addressing', 'R1', CONF, 'ipv6 uni'],
  ['ipv6-addressing', 'R1', IFACE, 'ipv6 addr 2001:DB8:ACAD:1::1/64'],
  ['ipv6-static-routing', 'R1', CONF, 'ipv6 rou ::/0 2001:DB8:ACAD:12::2'],
  ['ospf', 'R1', [...CONF, 'router ospf 1'], 'net 10.1.12.0 0.0.0.3 ar 0'],
  ['etherchannel', 'SW1', SW_PORT, 'channel-group 1 mod act'],
  ['ntp', 'R2', CONF, 'ntp ser 10.0.12.1'],
]

describe.each(ABBREVIATED)('%s/%s: %s', (id, dev, setup, cmd) => {
  it('is accepted', () => {
    expect(rejected(run(id, dev, setup, cmd))).toBe(false)
  })
})

describe('abbreviation still rejects what it should', () => {
  it.each([
    ['vlan-basics', 'SW1', SW_PORT, 'switchport mode bogus'],
    ['etherchannel', 'SW1', SW_PORT, 'channel-group 1 mode turbo'],
    ['ipv4-addressing', 'R1', IFACE, 'ip bogus 10.0.0.1'],
  ])('%s: %s', (id, dev, setup, cmd) => {
    expect(rejected(run(id, dev, setup, cmd))).toBe(true)
  })

  it('an abbreviation matching two keywords is not silently guessed', () => {
    // "s" under switchport matches nothing uniquely; it must not pick one.
    expect(rejected(run('vlan-basics', 'SW1', SW_PORT, 'switchport mode a'))).toBe(false)
    expect(rejected(run('l2-security', 'SW1', SW_PORT, 'switchport port-security ma 1'))).toBe(true)
  })
})

describe('interface accepts type and number as one token or two', () => {
  it.each([
    'interface gi0/0', 'interface GigabitEthernet 0/0', 'interface loopback 0', 'interface lo0',
  ])('%s', (cmd) => {
    expect(rejected(run('ospf', 'R3', CONF, cmd))).toBe(false)
  })

  it.each(['interface gi0/1 BOGUS', 'interface bogus9/9'])('rejects %s', (cmd) => {
    expect(rejected(run('ospf', 'R3', CONF, cmd))).toBe(true)
  })

  it('a loopback comes up on creation, with no shutdown needed', () => {
    const sim = getScenario('ospf').build()
    const cli = sim.consoles.R3
    for (const c of ['enable', 'conf t', 'interface loopback 0',
      'ip address 3.3.3.3 255.255.255.255', 'end']) cli.execute(c)
    const lo = sim.net.devices.R3.interfaces.Loopback0
    expect(lo.shutdown).toBe(false)
    expect(lo.lineProtocol).toBe(true)
    expect(cli.execute('show ip int brief').join('\n')).toMatch(/Loopback0 +3\.3\.3\.3 +YES manual up +up/)
  })
})

describe('? help resolves abbreviations too', () => {
  it.each([
    ['switchport ?', 'port-security'],
    ['switchport port-sec ?', 'maximum'],
    ['switchport mode ?', 'access'],
    ['ip ?', 'address'],
  ])('%s lists %s', (query, expected) => {
    const out = run('l2-security', 'SW1', SW_PORT, query)
    expect(out.join('\n')).toContain(expected)
  })

  it('help never throws on a partially typed keyword', () => {
    for (const q of ['switchport p ?', 'ip a ?', 'switchport trunk n ?']) {
      expect(() => run('l2-security', 'SW1', SW_PORT, q)).not.toThrow()
    }
  })
})
