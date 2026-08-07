// Lablet: VLANs & Trunking across two switches (blueprint 2.1 + 2.2).
//
// Topology:
//     PC1 ─┐                          ┌─ PC2      VLAN 10 (192.168.10.0/24)
//          ├ SW1 ═══ Gi0/24 trunk ═══ SW2 ┤
//     PC3 ─┘                          └─ PC4      VLAN 20 (192.168.20.0/24)
//
// The learner must create VLANs 10/20 on both switches, place each PC's access
// port in the right VLAN, trunk the SW1–SW2 link so the VLANs span both, and
// move the trunk's native VLAN off the default (blueprint 2.2.c).

import { createNetwork, addDevice, addLink } from '../engine/network.js'
import { ping } from '../engine/l3.js'
import { createDevice, createHost, getInterface, resetCounters } from '../engine/device.js'
import { CLI } from '../engine/cli.js'
import { HostCLI } from '../engine/hostcli.js'
import { vlanExists, portAccessVlan, portIsTrunk, isSaved, observedPing, observedShow,
  trunkNativeVlan } from '../engine/grader.js'

export const vlanBasics = {
  id: 'vlan-basics',
  title: 'VLANs & Trunking Across Two Switches',
  blueprint: ['2.1 VLANs (access, default, inter-VLAN)', '2.2 Trunking (802.1Q, native VLAN)'],
  intro: [
    'Two switches, SW1 and SW2, are joined by link Gi0/24. Four PCs are',
    'attached. Segment the network into two VLANs and let each VLAN talk',
    'across both switches.',
    '',
    'VLAN 10 = SALES  (192.168.10.0/24):  PC1 on SW1 Gi0/1, PC2 on SW2 Gi0/1',
    'VLAN 20 = ENG    (192.168.20.0/24):  PC3 on SW1 Gi0/2, PC4 on SW2 Gi0/2',
    'Native VLAN on the trunk = 99, created on both switches (ends must match).',
    '',
    'Then verify: show interfaces trunk on each switch, and PC1 can ping PC2,',
    'PC3 can ping PC4.',
  ],

  build() {
    resetCounters()
    const net = createNetwork()

    const sw1 = addDevice(net, createDevice({ id: 'SW1', kind: 'switch', hostname: 'SW1' }))
    const sw2 = addDevice(net, createDevice({ id: 'SW2', kind: 'switch', hostname: 'SW2' }))
    const pc1 = addDevice(net, createHost({ id: 'PC1', hostname: 'PC1', ip: '192.168.10.10', mask: '255.255.255.0' }))
    const pc2 = addDevice(net, createHost({ id: 'PC2', hostname: 'PC2', ip: '192.168.10.20', mask: '255.255.255.0' }))
    const pc3 = addDevice(net, createHost({ id: 'PC3', hostname: 'PC3', ip: '192.168.20.30', mask: '255.255.255.0' }))
    const pc4 = addDevice(net, createHost({ id: 'PC4', hostname: 'PC4', ip: '192.168.20.40', mask: '255.255.255.0' }))

    // Pre-create the interfaces so `show ip int brief` lists them from the start.
    for (const p of ['GigabitEthernet0/1', 'GigabitEthernet0/2', 'GigabitEthernet0/24']) {
      getInterface(sw1, p); getInterface(sw2, p)
    }

    addLink(net, 'PC1', 'NIC', 'SW1', 'GigabitEthernet0/1')
    addLink(net, 'PC3', 'NIC', 'SW1', 'GigabitEthernet0/2')
    addLink(net, 'PC2', 'NIC', 'SW2', 'GigabitEthernet0/1')
    addLink(net, 'PC4', 'NIC', 'SW2', 'GigabitEthernet0/2')
    addLink(net, 'SW1', 'GigabitEthernet0/24', 'SW2', 'GigabitEthernet0/24')

    const consoles = {
      SW1: new CLI(sw1, net),
      SW2: new CLI(sw2, net),
      PC1: new HostCLI(pc1, net),
      PC2: new HostCLI(pc2, net),
      PC3: new HostCLI(pc3, net),
      PC4: new HostCLI(pc4, net),
    }

    const layout = {
      nodes: [
        { id: 'PC1', x: 60, y: 40, label: 'PC1\n.10.10' },
        { id: 'PC3', x: 60, y: 150, label: 'PC3\n.20.30' },
        { id: 'SW1', x: 210, y: 95 },
        { id: 'SW2', x: 380, y: 95 },
        { id: 'PC2', x: 530, y: 40, label: 'PC2\n.10.20' },
        { id: 'PC4', x: 530, y: 150, label: 'PC4\n.20.40' },
      ],
      edges: [
        ['PC1', 'SW1'], ['PC3', 'SW1'], ['SW1', 'SW2'], ['PC2', 'SW2'], ['PC4', 'SW2'],
      ],
    }

    return { net, consoles, layout }
  },

  tasks: [
    {
      id: 'vlan10',
      text: 'Create VLAN 10 on both SW1 and SW2',
      hints: ['Create the VLAN in global config — on each switch.', 'SW1(config)# vlan 10   (repeat on SW2)'],
      check: (net) => vlanExists(net, 'SW1', 10) && vlanExists(net, 'SW2', 10),
    },
    {
      id: 'vlan20',
      text: 'Create VLAN 20 on both SW1 and SW2',
      hints: ['Same as VLAN 10, but the other VLAN.', 'SW1(config)# vlan 20   (repeat on SW2)'],
      check: (net) => vlanExists(net, 'SW1', 20) && vlanExists(net, 'SW2', 20),
    },
    {
      id: 'access10',
      text: 'Put PC1 (SW1 Gi0/1) and PC2 (SW2 Gi0/1) in VLAN 10',
      hints: ['Make each PC port an access port and assign it to VLAN 10.',
        'interface gi0/1 → switchport mode access → switchport access vlan 10'],
      check: (net) => portAccessVlan(net, 'SW1', 'gi0/1') === 10 && portAccessVlan(net, 'SW2', 'gi0/1') === 10,
    },
    {
      id: 'access20',
      text: 'Put PC3 (SW1 Gi0/2) and PC4 (SW2 Gi0/2) in VLAN 20',
      hints: ['Same idea as VLAN 10, on the Gi0/2 ports, into VLAN 20.',
        'interface gi0/2 → switchport mode access → switchport access vlan 20'],
      check: (net) => portAccessVlan(net, 'SW1', 'gi0/2') === 20 && portAccessVlan(net, 'SW2', 'gi0/2') === 20,
    },
    {
      id: 'trunk',
      text: 'Configure the SW1–SW2 link (Gi0/24) as a trunk on both ends',
      hints: ['The link between switches must carry BOTH VLANs — an access port can\'t. What port type carries multiple VLANs?',
        'interface gi0/24 → switchport mode trunk   (on both switches)'],
      check: (net) => portIsTrunk(net, 'SW1', 'gi0/24') && portIsTrunk(net, 'SW2', 'gi0/24'),
    },
    {
      id: 'native-vlan',
      text: 'Create VLAN 99 and make it the native VLAN on the Gi0/24 trunk — on BOTH ends',
      hints: ['Untagged frames on a trunk ride the native VLAN, which defaults to 1. Moving it to a dedicated, otherwise-unused VLAN is standard practice — but both ends must agree, or the switches report a native VLAN mismatch. Create the VLAN itself as well, so it exists in the database rather than being referenced out of thin air.',
        'vlan 99\ninterface gi0/24 → switchport trunk native vlan 99   (both commands on each switch)'],
      check: (net) =>
        vlanExists(net, 'SW1', 99) && vlanExists(net, 'SW2', 99) &&
        trunkNativeVlan(net, 'SW1', 'gi0/24') === 99 &&
        trunkNativeVlan(net, 'SW2', 'gi0/24') === 99,
    },
    {
      id: 'trunk-check',
      text: 'Verify: run show interfaces trunk on SW1 and SW2 — Gi0/24 is trunking VLANs 10 and 20 with native VLAN 99',
      hints: ['The trunk table is the direct evidence: mode, encapsulation, native VLAN, and which VLANs are allowed and active. Check the native VLAN column matches on both switches.',
        'SW1# show interfaces trunk   then the same on SW2'],
      check: (net) =>
        portIsTrunk(net, 'SW1', 'gi0/24') && portIsTrunk(net, 'SW2', 'gi0/24') &&
        trunkNativeVlan(net, 'SW1', 'gi0/24') === 99 &&
        trunkNativeVlan(net, 'SW2', 'gi0/24') === 99 &&
        observedShow(net, 'SW1', 'interfaces trunk') &&
        observedShow(net, 'SW2', 'interfaces trunk'),
    },
    {
      id: 'ping10',
      text: 'Verify: PC1 reaches PC2 across VLAN 10 (ping 192.168.10.20 from PC1)',
      hints: ['Open PC1\'s console and ping PC2. It only works once both ports are in VLAN 10 AND the trunk is up.',
        'PC1> ping 192.168.10.20'],
      // Reachable AND carried on the intended VLAN 10 (not the default flat VLAN 1).
      check: (net) =>
        portAccessVlan(net, 'SW1', 'gi0/1') === 10 &&
        portAccessVlan(net, 'SW2', 'gi0/1') === 10 &&
        ping(net, 'PC1', '192.168.10.20').ok &&
        observedPing(net, 'PC1', '192.168.10.20'),
    },
    {
      id: 'ping20',
      text: 'Verify: PC3 reaches PC4 across VLAN 20 (ping 192.168.20.40 from PC3)',
      hints: ['Open PC3\'s console and ping PC4.', 'PC3> ping 192.168.20.40'],
      check: (net) =>
        portAccessVlan(net, 'SW1', 'gi0/2') === 20 &&
        portAccessVlan(net, 'SW2', 'gi0/2') === 20 &&
        ping(net, 'PC3', '192.168.20.40').ok &&
        observedPing(net, 'PC3', '192.168.20.40'),
    },
    {
      id: 'save',
      text: 'Save the configuration on both SW1 and SW2 (do this last)',
      hints: ['Persist running-config to startup — and do it after everything else, or it\'ll go red again.',
        'SW1# write memory   (or: wr / save / copy running-config startup-config)'],
      // Goes red again if you edit after saving — so save once you are done.
      check: (net) => isSaved(net, 'SW1') && isSaved(net, 'SW2'),
    },
  ],
}
