// Lablet: Single-area OSPFv2 (blueprint 3.4).
//
// Same three-router topology as static routing, but now you run OSPF area 0 so
// the routers discover each other and learn all LANs dynamically.
//
//   PC1 ── R1 ══ R2 ══ R3 ── PC3      all in OSPF area 0

import { createNetwork, addDevice, addLink } from '../engine/network.js'
import { createDevice, createHost, getInterface, resetCounters } from '../engine/device.js'
import { CLI } from '../engine/cli.js'
import { HostCLI } from '../engine/hostcli.js'
import { pingWorks, routeCovers, ospfAdjacent, isSaved, observedPing, observedShow,
  ospfRouterIdIs } from '../engine/grader.js'

function ip(dev, name, addr, mask) {
  const i = getInterface(dev, name)
  i.ip = addr; i.mask = mask; i.shutdown = false; i.lineProtocol = true
  return i
}

export const ospfLab = {
  id: 'ospf',
  title: 'Single-Area OSPFv2',
  blueprint: ['3.4 Single-area OSPFv2'],
  intro: [
    'Three routers, each LAN with a PC. Interface IPs are pre-configured.',
    'Configure OSPF process 1, area 0, on all three routers so every LAN is',
    'reachable — no static routes.',
    '',
    'PC1 LAN  192.168.1.0/24    R1–R2  10.1.12.0/30',
    'PC3 LAN  192.168.3.0/24    R2–R3  10.1.23.0/30',
    '',
    'Advertise BOTH each router\'s LAN and its transit link(s) in area 0.',
    'Verify with: show ip ospf neighbor  /  show ip route  /  ping from PC1.',
  ],

  build() {
    resetCounters()
    const net = createNetwork()
    const r1 = addDevice(net, createDevice({ id: 'R1', kind: 'router', hostname: 'R1' }))
    const r2 = addDevice(net, createDevice({ id: 'R2', kind: 'router', hostname: 'R2' }))
    const r3 = addDevice(net, createDevice({ id: 'R3', kind: 'router', hostname: 'R3' }))
    const pc1 = addDevice(net, createHost({ id: 'PC1', hostname: 'PC1', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' }))
    const pc3 = addDevice(net, createHost({ id: 'PC3', hostname: 'PC3', ip: '192.168.3.10', mask: '255.255.255.0', gateway: '192.168.3.1' }))

    ip(r1, 'GigabitEthernet0/0', '192.168.1.1', '255.255.255.0')
    ip(r1, 'GigabitEthernet0/1', '10.1.12.1', '255.255.255.252')
    ip(r2, 'GigabitEthernet0/1', '10.1.12.2', '255.255.255.252')
    ip(r2, 'GigabitEthernet0/2', '10.1.23.1', '255.255.255.252')
    ip(r3, 'GigabitEthernet0/1', '10.1.23.2', '255.255.255.252')
    ip(r3, 'GigabitEthernet0/0', '192.168.3.1', '255.255.255.0')

    addLink(net, 'PC1', 'NIC', 'R1', 'GigabitEthernet0/0')
    addLink(net, 'R1', 'GigabitEthernet0/1', 'R2', 'GigabitEthernet0/1')
    addLink(net, 'R2', 'GigabitEthernet0/2', 'R3', 'GigabitEthernet0/1')
    addLink(net, 'PC3', 'NIC', 'R3', 'GigabitEthernet0/0')

    const consoles = {
      R1: new CLI(r1, net), R2: new CLI(r2, net), R3: new CLI(r3, net),
      PC1: new HostCLI(pc1, net), PC3: new HostCLI(pc3, net),
    }
    const layout = {
      nodes: [
        { id: 'PC1', x: 30, y: 90, label: 'PC1\n.1.10' },
        { id: 'R1', x: 150, y: 90 },
        { id: 'R2', x: 285, y: 90 },
        { id: 'R3', x: 420, y: 90 },
        { id: 'PC3', x: 545, y: 90, label: 'PC3\n.3.10' },
      ],
      edges: [['PC1', 'R1'], ['R1', 'R2'], ['R2', 'R3'], ['R3', 'PC3']],
    }
    return { net, consoles, layout }
  },

  tasks: [
    {
      id: 'router-id',
      text: 'On R1, start OSPF process 1 and pin its router-id to 1.1.1.1',
      hints: ['Without an explicit router-id OSPF picks one from the interfaces — pin it so the ID is predictable.',
        'R1(config)# router ospf 1 → router-id 1.1.1.1'],
      check: (net) => ospfRouterIdIs(net, 'R1', '1.1.1.1'),
    },
    {
      id: 'adj-12',
      text: 'Form an OSPF adjacency between R1 and R2',
      hints: ['Run OSPF on both routers and advertise the 10.1.12.0/30 link in area 0 so they become neighbors.',
        'router ospf 1 → network 10.1.12.0 0.0.0.3 area 0  (on R1 and R2)'],
      check: (net) => ospfAdjacent(net, 'R1', 'R2') && ospfAdjacent(net, 'R2', 'R1'),
    },
    {
      id: 'adj-23',
      text: 'Form an OSPF adjacency between R2 and R3',
      hints: ['Same for the R2–R3 link.',
        'router ospf 1 → network 10.1.23.0 0.0.0.3 area 0  (on R2 and R3)'],
      check: (net) => ospfAdjacent(net, 'R2', 'R3') && ospfAdjacent(net, 'R3', 'R2'),
    },
    {
      id: 'r1-learns-lan3',
      text: 'R1 learns the PC3 LAN (192.168.3.0/24) via OSPF',
      hints: ['R3 must ADVERTISE its LAN for R1 to learn it — add a network statement for 192.168.3.0 on R3.',
        'R3(config-router)# network 192.168.3.0 0.0.0.255 area 0'],
      check: (net) => routeCovers(net, 'R1', '192.168.3.10', 'O'),
    },
    {
      id: 'r3-learns-lan1',
      text: 'R3 learns the PC1 LAN (192.168.1.0/24) via OSPF',
      hints: ['Likewise, R1 must advertise its LAN.',
        'R1(config-router)# network 192.168.1.0 0.0.0.255 area 0'],
      check: (net) => routeCovers(net, 'R3', '192.168.1.10', 'O'),
    },
    {
      id: 'nbr-check',
      text: 'Verify: run show ip ospf neighbor on R2 — both R1 and R3 are listed',
      hints: ['R2 sits in the middle, so its neighbour table should show an adjacency on each side.',
        'R2# show ip ospf neighbor'],
      check: (net) =>
        ospfAdjacent(net, 'R2', 'R1') && ospfAdjacent(net, 'R2', 'R3') &&
        observedShow(net, 'R2', 'ip ospf neighbor'),
    },
    {
      id: 'ping',
      text: 'Verify: PC1 can ping PC3 (192.168.3.10)',
      hints: ['With OSPF converged and both LANs advertised, end-to-end should work.',
        'PC1> ping 192.168.3.10'],
      check: (net) => pingWorks(net, 'PC1', '192.168.3.10') &&
        observedPing(net, 'PC1', '192.168.3.10'),
    },
    {
      id: 'save',
      text: 'Save the configuration on R1, R2, and R3',
      hints: ['Persist to startup on all three — last.', 'R1# write memory'],
      check: (net) => isSaved(net, 'R1') && isSaved(net, 'R2') && isSaved(net, 'R3'),
    },
  ],
}
