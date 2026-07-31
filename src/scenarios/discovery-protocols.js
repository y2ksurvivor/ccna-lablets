// Lablet: Layer 2 Discovery Protocols — CDP & LLDP (blueprint 2.3).
//
// Topology:   R1 ── Gi0/1 [SW1] Gi0/2 ── Gi0/1 [SW2]
//
// CDP runs by default, but someone disabled it on SW1's link to R1, so R1 is
// missing from SW1's CDP table. LLDP is off everywhere (IOS default). Fix CDP,
// turn on LLDP, and verify neighbors appear.

import { createNetwork, addDevice, addLink } from '../engine/network.js'
import { createDevice, getInterface, resetCounters } from '../engine/device.js'
import { CLI } from '../engine/cli.js'
import { discoverySeesNeighbor, globalDiscoveryOn } from '../engine/grader.js'

export const discoveryProtocols = {
  id: 'discovery-protocols',
  title: 'Discovery Protocols (CDP & LLDP)',
  blueprint: ['2.3 CDP & LLDP'],
  intro: [
    'R1 connects to SW1 (Gi0/1). SW1 connects to SW2 (Gi0/2 ── Gi0/1).',
    '',
    'Problem: CDP was disabled on SW1\'s Gi0/1, so R1 is missing from SW1\'s',
    'CDP neighbor table. Also, LLDP is off everywhere by default.',
    '',
    'Goals:',
    ' 1. Re-enable CDP on SW1 Gi0/1 so SW1 discovers R1.',
    ' 2. Turn on LLDP globally on SW1 and SW2.',
    ' 3. Verify SW1 and SW2 discover each other via LLDP.',
    '',
    'Verify with: show cdp neighbors  /  show lldp neighbors',
  ],

  build() {
    resetCounters()
    const net = createNetwork()
    const r1 = addDevice(net, createDevice({ id: 'R1', kind: 'router', hostname: 'R1' }))
    const sw1 = addDevice(net, createDevice({ id: 'SW1', kind: 'switch', hostname: 'SW1' }))
    const sw2 = addDevice(net, createDevice({ id: 'SW2', kind: 'switch', hostname: 'SW2' }))

    const r1g0 = getInterface(r1, 'GigabitEthernet0/0')
    r1g0.shutdown = false // router link brought up for you
    for (const p of ['GigabitEthernet0/1', 'GigabitEthernet0/2']) { getInterface(sw1, p) }
    getInterface(sw2, 'GigabitEthernet0/1')

    addLink(net, 'R1', 'GigabitEthernet0/0', 'SW1', 'GigabitEthernet0/1')
    addLink(net, 'SW1', 'GigabitEthernet0/2', 'SW2', 'GigabitEthernet0/1')

    // The pre-seeded fault: CDP disabled on SW1's port toward R1.
    getInterface(sw1, 'GigabitEthernet0/1').cdpEnabled = false

    const consoles = { R1: new CLI(r1, net), SW1: new CLI(sw1, net), SW2: new CLI(sw2, net) }
    const layout = {
      nodes: [
        { id: 'R1', x: 60, y: 90 },
        { id: 'SW1', x: 250, y: 90 },
        { id: 'SW2', x: 440, y: 90 },
      ],
      edges: [['R1', 'SW1'], ['SW1', 'SW2']],
    }
    return { net, consoles, layout }
  },

  tasks: [
    {
      id: 'cdp-fix',
      text: 'Re-enable CDP on SW1 Gi0/1 so SW1 discovers R1',
      hints: ['CDP was turned off on one interface. Go into that interface and turn it back on.',
        'interface gi0/1 → cdp enable'],
      check: (net) => discoverySeesNeighbor(net, 'SW1', 'cdp', 'R1'),
    },
    {
      id: 'lldp-on',
      text: 'Enable LLDP globally on SW1 and SW2',
      hints: ['LLDP is off by default (unlike CDP). Turn it on globally on each switch.',
        'SW1(config)# lldp run   (repeat on SW2)'],
      check: (net) => globalDiscoveryOn(net, 'SW1', 'lldp') && globalDiscoveryOn(net, 'SW2', 'lldp'),
    },
    {
      id: 'lldp-verify',
      text: 'Verify: SW1 and SW2 see each other as LLDP neighbors',
      hints: ['Check the LLDP neighbor table on each switch.', 'SW1# show lldp neighbors'],
      check: (net) =>
        discoverySeesNeighbor(net, 'SW1', 'lldp', 'SW2') &&
        discoverySeesNeighbor(net, 'SW2', 'lldp', 'SW1'),
    },
  ],
}
