// Lablet: IPv4 addressing & subnetting (blueprint 1.6).
//
// Topology:  PC1 ── R1 ── PC2   (two LANs on one router)
//
// You are given 192.168.50.0/24 to subnet into /26s. Address R1's two LAN
// interfaces as the first usable host of the first two /26 subnets, bring them
// up, and verify the PCs (already addressed in those subnets) can reach across.

import { createNetwork, addDevice, addLink } from '../engine/network.js'
import { createDevice, createHost, getInterface, resetCounters } from '../engine/device.js'
import { CLI } from '../engine/cli.js'
import { HostCLI } from '../engine/hostcli.js'
import { ifaceHasIp, pingWorks, isSaved, observedPing, observedShow } from '../engine/grader.js'

export const ipv4Addressing = {
  id: 'ipv4-addressing',
  title: 'IPv4 Addressing & Subnetting',
  blueprint: ['1.6 IPv4 addressing & subnetting'],
  intro: [
    'Subnet 192.168.50.0/24 into /26 networks (mask 255.255.255.192) and',
    'address R1. The /26 subnets are .0, .64, .128, .192.',
    '',
    'LAN1 (PC1 = 192.168.50.10): use subnet 192.168.50.0/26  → R1 g0/0 = .1',
    'LAN2 (PC2 = 192.168.50.74): use subnet 192.168.50.64/26 → R1 g0/1 = .65',
    '',
    'Router interfaces start shut and unaddressed — configure and no shut both,',
    'then verify PC1 can reach PC2. (show ip interface brief helps.)',
  ],

  build() {
    resetCounters()
    const net = createNetwork()
    const r1 = addDevice(net, createDevice({ id: 'R1', kind: 'router', hostname: 'R1' }))
    const pc1 = addDevice(net, createHost({ id: 'PC1', hostname: 'PC1', ip: '192.168.50.10', mask: '255.255.255.192', gateway: '192.168.50.1' }))
    const pc2 = addDevice(net, createHost({ id: 'PC2', hostname: 'PC2', ip: '192.168.50.74', mask: '255.255.255.192', gateway: '192.168.50.65' }))
    // Interfaces exist but are unconfigured + shut (router default).
    getInterface(r1, 'GigabitEthernet0/0')
    getInterface(r1, 'GigabitEthernet0/1')
    addLink(net, 'PC1', 'NIC', 'R1', 'GigabitEthernet0/0')
    addLink(net, 'PC2', 'NIC', 'R1', 'GigabitEthernet0/1')

    const consoles = { R1: new CLI(r1, net), PC1: new HostCLI(pc1, net), PC2: new HostCLI(pc2, net) }
    const layout = {
      nodes: [
        { id: 'PC1', x: 40, y: 90, label: 'PC1\n.10' },
        { id: 'R1', x: 260, y: 90 },
        { id: 'PC2', x: 470, y: 90, label: 'PC2\n.74' },
      ],
      edges: [['PC1', 'R1'], ['R1', 'PC2']],
    }
    return { net, consoles, layout }
  },

  tasks: [
    {
      id: 'lan1',
      text: 'Address R1 g0/0 as 192.168.50.1 /26 and bring it up',
      hints: ['First usable host of the 192.168.50.0/26 subnet, mask 255.255.255.192, then no shutdown.',
        'interface gi0/0 → ip address 192.168.50.1 255.255.255.192 → no shutdown'],
      check: (net) => ifaceHasIp(net, 'R1', 'gi0/0', '192.168.50.1', '255.255.255.192'),
    },
    {
      id: 'lan2',
      text: 'Address R1 g0/1 as 192.168.50.65 /26 and bring it up',
      hints: ['First usable host of the 192.168.50.64/26 subnet (the next /26 block starts at .64).',
        'interface gi0/1 → ip address 192.168.50.65 255.255.255.192 → no shutdown'],
      check: (net) => ifaceHasIp(net, 'R1', 'gi0/1', '192.168.50.65', '255.255.255.192'),
    },
    {
      id: 'intf-check',
      text: 'Verify: run show ip interface brief on R1 — both LAN interfaces are up',
      hints: ['Read the addresses back off the router before trusting them.',
        'R1# show ip interface brief'],
      check: (net) =>
        ifaceHasIp(net, 'R1', 'gi0/0', '192.168.50.1', '255.255.255.192') &&
        ifaceHasIp(net, 'R1', 'gi0/1', '192.168.50.65', '255.255.255.192') &&
        observedShow(net, 'R1', 'ip interface brief'),
    },
    {
      id: 'ping',
      text: 'Verify: PC1 can ping PC2 across the two subnets',
      hints: ['Correct addressing on both LANs means R1 routes between them automatically (connected routes).',
        'PC1> ping 192.168.50.74'],
      check: (net) => pingWorks(net, 'PC1', '192.168.50.74') &&
        observedPing(net, 'PC1', '192.168.50.74'),
    },
    {
      id: 'save',
      text: 'Save the configuration on R1',
      hints: ['Persist to startup.', 'R1# write memory'],
      check: (net) => isSaved(net, 'R1'),
    },
  ],
}
