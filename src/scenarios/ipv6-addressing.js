// Lablet: IPv6 addressing & prefix (blueprint 1.8).
//
// Topology:  R1 ══ R2   (one link, address both ends from a /64)

import { createNetwork, addDevice, addLink } from '../engine/network.js'
import { createDevice, getInterface, resetCounters } from '../engine/device.js'
import { CLI } from '../engine/cli.js'
import { ifaceHasIpv6, ipv6PingWorks, ipv6RoutingOn, isSaved, observedPing, observedShow } from '../engine/grader.js'

export const ipv6Addressing = {
  id: 'ipv6-addressing',
  title: 'IPv6 Addressing & Prefix',
  blueprint: ['1.8 IPv6 addressing & prefix'],
  intro: [
    'R1 and R2 share a link. Enable IPv6 routing and address both ends from the',
    '2001:DB8:ACAD:1::/64 prefix, then verify they can reach each other.',
    '',
    'R1 g0/0 = 2001:DB8:ACAD:1::1/64',
    'R2 g0/0 = 2001:DB8:ACAD:1::2/64',
    '',
    'Verify with: show ipv6 interface brief  and  ping.',
  ],

  build() {
    resetCounters()
    const net = createNetwork()
    const r1 = addDevice(net, createDevice({ id: 'R1', kind: 'router', hostname: 'R1' }))
    const r2 = addDevice(net, createDevice({ id: 'R2', kind: 'router', hostname: 'R2' }))
    // Bring the link up so line protocol is up; addressing is the exercise.
    const a = getInterface(r1, 'GigabitEthernet0/0'); a.shutdown = false; a.lineProtocol = true
    const b = getInterface(r2, 'GigabitEthernet0/0'); b.shutdown = false; b.lineProtocol = true
    addLink(net, 'R1', 'GigabitEthernet0/0', 'R2', 'GigabitEthernet0/0')

    const consoles = { R1: new CLI(r1, net), R2: new CLI(r2, net) }
    const layout = {
      nodes: [{ id: 'R1', x: 150, y: 90 }, { id: 'R2', x: 400, y: 90 }],
      edges: [['R1', 'R2']],
    }
    return { net, consoles, layout }
  },

  tasks: [
    {
      id: 'routing',
      text: 'Enable IPv6 unicast routing on both R1 and R2',
      hints: ['A single global command turns on IPv6 routing (off by default).',
        'R1(config)# ipv6 unicast-routing   (also on R2)'],
      check: (net) => ipv6RoutingOn(net, 'R1') && ipv6RoutingOn(net, 'R2'),
    },
    {
      id: 'r1-addr',
      text: 'Address R1 g0/0 as 2001:DB8:ACAD:1::1/64',
      hints: ['Configure the global unicast address with its /64 prefix length.',
        'interface gi0/0 → ipv6 address 2001:DB8:ACAD:1::1/64'],
      check: (net) => ifaceHasIpv6(net, 'R1', 'gi0/0', '2001:DB8:ACAD:1::1/64'),
    },
    {
      id: 'r2-addr',
      text: 'Address R2 g0/0 as 2001:DB8:ACAD:1::2/64',
      hints: ['Same /64 prefix, host portion ::2.',
        'interface gi0/0 → ipv6 address 2001:DB8:ACAD:1::2/64'],
      check: (net) => ifaceHasIpv6(net, 'R2', 'gi0/0', '2001:DB8:ACAD:1::2/64'),
    },
    {
      id: 'intf-check',
      text: 'Verify: run show ipv6 interface brief on R1 — the /64 is on Gi0/0',
      hints: ['Confirm the prefix landed on the interface (and note the link-local alongside it).',
        'R1# show ipv6 interface brief'],
      check: (net) =>
        ifaceHasIpv6(net, 'R1', 'gi0/0', '2001:DB8:ACAD:1::1/64') &&
        observedShow(net, 'R1', 'ipv6 interface brief'),
    },
    {
      id: 'ping',
      text: 'Verify: R1 can ping R2 over IPv6 (2001:DB8:ACAD:1::2)',
      hints: ['Both ends on the same /64 and up — ping the neighbor\'s address.',
        'R1# ping 2001:DB8:ACAD:1::2'],
      check: (net) => ipv6PingWorks(net, 'R1', '2001:DB8:ACAD:1::2') &&
        observedPing(net, 'R1', '2001:DB8:ACAD:1::2'),
    },
    {
      id: 'save',
      text: 'Save the configuration on R1 and R2',
      hints: ['Persist on both.', 'R1# write memory'],
      check: (net) => isSaved(net, 'R1') && isSaved(net, 'R2'),
    },
  ],
}
