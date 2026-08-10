// Every command in every lablet, checked two ways: the real form is accepted,
// and the same form with a trailing token is rejected.
//
// A command that silently drops what it does not understand is the worst
// failure mode this simulator has — "switchport mode trunk native vlan 99" set
// the mode, discarded the native VLAN, and printed nothing, leaving the learner
// certain they had configured something they had not.

import { describe, it, expect } from 'vitest'
import { getScenario } from '../src/scenarios/index.js'

// [lablet, device, setup, command]
const COMMANDS = [
  ['ssh', 'R1', ['enable', 'conf t'], 'hostname R9'],
  ['ssh', 'R1', ['enable', 'conf t'], 'ip domain-name lab.local'],
  ['ssh', 'R1', ['enable', 'conf t'], 'username admin secret cisco123'],
  ['ssh', 'R1', ['enable', 'conf t'], 'crypto key generate rsa modulus 1024'],
  ['ssh', 'R1', ['enable', 'conf t'], 'line vty 0 4'],
  ['ssh', 'R1', ['enable', 'conf t', 'line vty 0 4'], 'login local'],
  ['ssh', 'R1', ['enable', 'conf t', 'line vty 0 4'], 'transport input ssh'],
  ['device-hardening', 'R1', ['enable', 'conf t'], 'enable secret cisco123'],
  ['device-hardening', 'R1', ['enable', 'conf t'], 'service password-encryption'],
  ['device-hardening', 'R1', ['enable', 'conf t'], 'line console 0'],
  ['ntp', 'R2', ['enable', 'conf t'], 'ntp server 10.0.12.1'],
  ['ntp', 'R1', ['enable', 'conf t'], 'ntp master 3'],
  ['ospf', 'R1', ['enable', 'conf t'], 'router ospf 1'],
  ['ospf', 'R1', ['enable', 'conf t', 'router ospf 1'], 'router-id 1.1.1.1'],
  ['ospf', 'R1', ['enable', 'conf t', 'router ospf 1'], 'network 10.1.12.0 0.0.0.3 area 0'],
  ['dhcp', 'R2', ['enable', 'conf t'], 'ip dhcp pool LAN1'],
  ['dhcp', 'R2', ['enable', 'conf t', 'ip dhcp pool LAN1'], 'network 192.168.1.0 255.255.255.0'],
  ['dhcp', 'R2', ['enable', 'conf t', 'ip dhcp pool LAN1'], 'default-router 192.168.1.1'],
  ['dhcp', 'R2', ['enable', 'conf t', 'ip dhcp pool LAN1'], 'dns-server 8.8.8.8'],
  ['dhcp', 'R2', ['enable', 'conf t'], 'ip dhcp excluded-address 192.168.1.1'],
  ['dhcp', 'R1', ['enable', 'conf t', 'interface gi0/0'], 'ip helper-address 10.0.12.2'],
  ['l2-security', 'SW1', ['enable', 'conf t'], 'ip dhcp snooping vlan 10'],
  ['l2-security', 'SW1', ['enable', 'conf t'], 'ip arp inspection vlan 10'],
  ['l2-security', 'SW1', ['enable', 'conf t', 'interface gi0/24'], 'ip dhcp snooping trust'],
  ['l2-security', 'SW1', ['enable', 'conf t', 'interface gi0/1'], 'switchport port-security maximum 1'],
  ['nat', 'R1', ['enable', 'conf t', 'interface gi0/0'], 'ip nat inside'],
  ['nat', 'R1', ['enable', 'conf t'], 'ip nat pool P1 203.0.113.10 203.0.113.20 netmask 255.255.255.0'],
  ['nat', 'R1', ['enable', 'conf t'], 'ip nat inside source static 192.168.1.10 203.0.113.10'],
  ['acl', 'R1', ['enable', 'conf t', 'interface gi0/1'], 'ip access-group 10 out'],
  ['ipv6-addressing', 'R1', ['enable', 'conf t'], 'ipv6 unicast-routing'],
  ['ipv6-addressing', 'R1', ['enable', 'conf t', 'interface gi0/0'], 'ipv6 address 2001:DB8:ACAD:1::1/64'],
  ['ipv6-static-routing', 'R1', ['enable', 'conf t'], 'ipv6 route ::/0 2001:DB8:ACAD:12::2'],
  ['discovery-protocols', 'SW1', ['enable', 'conf t'], 'lldp run'],
  ['discovery-protocols', 'SW1', ['enable', 'conf t', 'interface gi0/1'], 'cdp enable'],
  ['ipv4-addressing', 'R1', ['enable', 'conf t', 'interface gi0/0'], 'ip address 10.0.0.1 255.255.255.0'],
  ['ipv4-addressing', 'R1', ['enable', 'conf t', 'interface gi0/0'], 'no shutdown'],
  ['ipv4-addressing', 'R1', ['enable'], 'write memory'],
  ['static-routing', 'R1', ['enable', 'conf t'], 'ip route 0.0.0.0 0.0.0.0 10.1.12.2'],
  ['static-routing', 'R1', ['enable', 'conf t'], 'ip route 0.0.0.0 0.0.0.0 10.1.12.2 200'],
  ['vlan-basics', 'SW1', ['enable', 'conf t'], 'vlan 10'],
  ['vlan-basics', 'SW1', ['enable', 'conf t', 'vlan 10'], 'name SALES'],
  ['vlan-basics', 'SW1', ['enable', 'conf t'], 'interface gi0/1'],
  ['vlan-basics', 'SW1', ['enable', 'conf t', 'interface gi0/24'], 'switchport mode trunk'],
  ['vlan-basics', 'SW1', ['enable', 'conf t', 'interface gi0/24'], 'switchport trunk native vlan 99'],
  ['vlan-basics', 'SW1', ['enable', 'conf t', 'interface gi0/1'], 'switchport mode access'],
  ['vlan-basics', 'SW1', ['enable', 'conf t', 'interface gi0/1'], 'switchport access vlan 10'],
  ['etherchannel', 'SW1', ['enable', 'conf t', 'interface gi0/1'], 'channel-group 1 mode active'],
]

const run = (id, dev, setup, cmd) => {
  const cli = getScenario(id).build().consoles[dev]
  for (const c of setup) cli.execute(c)
  return cli.execute(cmd)
}
const isError = (out) => out.length > 0 && /Invalid input|Incomplete command/.test(out.join('\n'))

describe.each(COMMANDS)('%s/%s: %s → %s', (id, dev, setup, cmd) => {
  it('is accepted', () => {
    expect(isError(run(id, dev, setup, cmd))).toBe(false)
  })

  it('rejects a trailing token', () => {
    expect(isError(run(id, dev, setup, `${cmd} BOGUS`))).toBe(true)
  })
})

describe('commands that legitimately take a variable tail', () => {
  it.each([
    ['ipv4-addressing', 'R1', ['enable', 'conf t', 'interface gi0/0'], 'description uplink to the SALES vlan'],
    ['ssh', 'R1', ['enable', 'conf t', 'line vty 0 4'], 'transport input ssh telnet'],
    ['acl', 'R1', ['enable', 'conf t'], 'access-list 10 deny host 192.168.1.20'],
    ['dhcp', 'R2', ['enable', 'conf t'], 'ip dhcp excluded-address 192.168.1.1 192.168.1.9'],
  ])('%s: %s', (id, dev, setup, cmd) => {
    expect(isError(run(id, dev, setup, cmd))).toBe(false)
  })

  it('still rejects a non-protocol in a transport list', () => {
    expect(isError(run('ssh', 'R1', ['enable', 'conf t', 'line vty 0 4'],
      'transport input ssh BOGUS'))).toBe(true)
  })

  it('still rejects a non-address as a DHCP exclusion range end', () => {
    expect(isError(run('dhcp', 'R2', ['enable', 'conf t'],
      'ip dhcp excluded-address 192.168.1.1 BOGUS'))).toBe(true)
  })
})
