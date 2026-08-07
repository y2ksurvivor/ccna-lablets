// Lablet: Layer 2 security — port security, DHCP snooping, DAI (blueprint 5.7).
//
// Topology:  PC1, PC2 on SW1 access ports (VLAN 10); Gi0/24 is the uplink.

import { createNetwork, addDevice, addLink } from '../engine/network.js'
import { createDevice, createHost, getInterface, resetCounters } from '../engine/device.js'
import { CLI } from '../engine/cli.js'
import { HostCLI } from '../engine/hostcli.js'
import { portSecured, dhcpSnoopingOn, arpInspectionOn, ifaceTrusted, isSaved,
  observedShow } from '../engine/grader.js'

export const l2Security = {
  id: 'l2-security',
  title: 'Layer 2 Security (port security, DHCP snooping, DAI)',
  blueprint: ['5.7 Port security, DHCP snooping, DAI'],
  intro: [
    'Lock down access-layer switch SW1. PC1 and PC2 are on VLAN 10 (Gi0/1,',
    'Gi0/2); Gi0/24 is the trusted uplink toward the DHCP server / gateway.',
    '',
    'Goals:',
    ' 1. Port security on the access ports (max 1 MAC, sticky, shut on abuse).',
    ' 2. DHCP snooping globally and on VLAN 10; trust the uplink.',
    ' 3. Dynamic ARP Inspection on VLAN 10.',
    '',
    'Verify with: show port-security  /  show running-config',
  ],

  build() {
    resetCounters()
    const net = createNetwork()
    const sw = addDevice(net, createDevice({ id: 'SW1', kind: 'switch', hostname: 'SW1' }))
    const pc1 = addDevice(net, createHost({ id: 'PC1', hostname: 'PC1', ip: '192.168.10.11', mask: '255.255.255.0' }))
    const pc2 = addDevice(net, createHost({ id: 'PC2', hostname: 'PC2', ip: '192.168.10.12', mask: '255.255.255.0' }))
    // Pre-stage VLAN 10 and access ports so the lab is about security only.
    sw.vlans[10] = { id: 10, name: 'USERS' }
    for (const [p, v] of [['GigabitEthernet0/1', 10], ['GigabitEthernet0/2', 10]]) {
      const i = getInterface(sw, p); i.mode = 'access'; i.accessVlan = v
    }
    getInterface(sw, 'GigabitEthernet0/24') // uplink (trunk-ish, left as default)
    addLink(net, 'PC1', 'NIC', 'SW1', 'GigabitEthernet0/1')
    addLink(net, 'PC2', 'NIC', 'SW1', 'GigabitEthernet0/2')

    const consoles = { SW1: new CLI(sw, net), PC1: new HostCLI(pc1, net), PC2: new HostCLI(pc2, net) }
    const layout = {
      nodes: [
        { id: 'PC1', x: 60, y: 40, label: 'PC1' },
        { id: 'PC2', x: 60, y: 150, label: 'PC2' },
        { id: 'SW1', x: 280, y: 95 },
      ],
      edges: [['PC1', 'SW1'], ['PC2', 'SW1']],
    }
    return { net, consoles, layout }
  },

  tasks: [
    {
      id: 'portsec',
      text: 'Enable port security on Gi0/1 and Gi0/2 (max 1, sticky, violation shutdown)',
      hints: ['Turn on port-security and set the max MAC count, sticky learning, and violation action on each access port.',
        'interface gi0/1 → switchport port-security → switchport port-security maximum 1 → switchport port-security mac-address sticky → switchport port-security violation shutdown  (repeat gi0/2)'],
      check: (net) =>
        portSecured(net, 'SW1', 'gi0/1', { maximum: 1, sticky: true, violation: 'shutdown' }) &&
        portSecured(net, 'SW1', 'gi0/2', { maximum: 1, sticky: true, violation: 'shutdown' }),
    },
    {
      id: 'snoop',
      text: 'Enable DHCP snooping globally and on VLAN 10',
      hints: ['Two commands: turn snooping on globally, then bind it to the data VLAN.',
        'ip dhcp snooping\nip dhcp snooping vlan 10'],
      check: (net) => dhcpSnoopingOn(net, 'SW1', 10),
    },
    {
      id: 'trust',
      text: 'Trust the uplink Gi0/24 for DHCP snooping',
      hints: ['The port toward the real DHCP server must be trusted, or valid offers get dropped.',
        'interface gi0/24 → ip dhcp snooping trust'],
      check: (net) => ifaceTrusted(net, 'SW1', 'gi0/24', 'dhcp'),
    },
    {
      id: 'dai',
      text: 'Enable Dynamic ARP Inspection on VLAN 10',
      hints: ['DAI leans on the DHCP snooping binding table to validate ARP on the VLAN.',
        'ip arp inspection vlan 10'],
      check: (net) => arpInspectionOn(net, 'SW1', 10),
    },
    {
      id: 'portsec-check',
      text: 'Verify: run show port-security on SW1 — both access ports are secured',
      hints: ['Confirm the port-security state, max count, and violation action per port.',
        'SW1# show port-security'],
      check: (net) =>
        portSecured(net, 'SW1', 'gi0/1', { maximum: 1, sticky: true, violation: 'shutdown' }) &&
        portSecured(net, 'SW1', 'gi0/2', { maximum: 1, sticky: true, violation: 'shutdown' }) &&
        observedShow(net, 'SW1', 'port-security'),
    },
    {
      id: 'save',
      text: 'Save the configuration on SW1',
      hints: ['Persist to startup.', 'SW1# write memory'],
      check: (net) => isSaved(net, 'SW1'),
    },
  ],
}
