// Lablet: IPv6 static routing (blueprint 3.3, the IPv6 half).
//
// Topology (all interface addresses pre-configured — you configure routing only):
//
//   [LAN A] ── R1 ══ R2 ══ R3 ── [LAN C]
//
//   LAN A       2001:DB8:ACAD:A::/64    (R1 g0/0 = ...:A::1)
//   R1–R2 link  2001:DB8:ACAD:12::/64   (R1 g0/1 = ::1, R2 g0/1 = ::2)
//   R2–R3 link  2001:DB8:ACAD:23::/64   (R2 g0/2 = ::1, R3 g0/1 = ::2)
//   LAN C       2001:DB8:ACAD:C::/64    (R3 g0/0 = ...:C::1)
//
// Same shape as the IPv4 static-routing lablet on purpose: defaults on the edge
// routers, specific prefixes on the middle one. The commands differ (ipv6 route,
// and unicast routing must be switched on) but the reasoning transfers.

import { createNetwork, addDevice, addLink } from '../engine/network.js'
import { createDevice, getInterface, resetCounters } from '../engine/device.js'
import { CLI } from '../engine/cli.js'
import {
  ipv6RoutingOn, isSaved, observedShow, hasIpv6Route, ipv6RouteVia, ipv6PingWorks,
} from '../engine/grader.js'

const LAN_A = '2001:DB8:ACAD:A::'
const LAN_C = '2001:DB8:ACAD:C::'
const R3_LAN_C = '2001:DB8:ACAD:C::1'

function v6(dev, name, addr) {
  const i = getInterface(dev, name)
  i.ipv6.push(addr)
  i.shutdown = false
  i.lineProtocol = true
}

export const ipv6StaticRouting = {
  id: 'ipv6-static-routing',
  title: 'IPv6 Static Routing',
  blueprint: ['3.3 IPv6 static routing (default & network routes)'],
  intro: [
    'Three routers in a line. Every interface already carries its IPv6 address —',
    'your job is the routing, so R1 can reach LAN C behind R3.',
    '',
    'LAN A       2001:DB8:ACAD:A::/64    R1 g0/0',
    'R1–R2 link  2001:DB8:ACAD:12::/64   R1 g0/1 = ::1, R2 g0/1 = ::2',
    'R2–R3 link  2001:DB8:ACAD:23::/64   R2 g0/2 = ::1, R3 g0/1 = ::2',
    'LAN C       2001:DB8:ACAD:C::/64    R3 g0/0',
    '',
    'Plan: unicast routing on all three, default routes on R1 and R3 pointing at',
    'R2, and a specific route to each LAN on R2.',
    '',
    'Verify with: show ipv6 route  and  ping 2001:DB8:ACAD:C::1 from R1.',
  ],

  build() {
    resetCounters()
    const net = createNetwork()
    const r1 = addDevice(net, createDevice({ id: 'R1', kind: 'router', hostname: 'R1' }))
    const r2 = addDevice(net, createDevice({ id: 'R2', kind: 'router', hostname: 'R2' }))
    const r3 = addDevice(net, createDevice({ id: 'R3', kind: 'router', hostname: 'R3' }))

    v6(r1, 'GigabitEthernet0/0', `${LAN_A}1/64`)
    v6(r1, 'GigabitEthernet0/1', '2001:DB8:ACAD:12::1/64')
    v6(r2, 'GigabitEthernet0/1', '2001:DB8:ACAD:12::2/64')
    v6(r2, 'GigabitEthernet0/2', '2001:DB8:ACAD:23::1/64')
    v6(r3, 'GigabitEthernet0/1', '2001:DB8:ACAD:23::2/64')
    v6(r3, 'GigabitEthernet0/0', `${LAN_C}1/64`)

    addLink(net, 'R1', 'GigabitEthernet0/1', 'R2', 'GigabitEthernet0/1')
    addLink(net, 'R2', 'GigabitEthernet0/2', 'R3', 'GigabitEthernet0/1')

    const consoles = { R1: new CLI(r1, net), R2: new CLI(r2, net), R3: new CLI(r3, net) }
    const layout = {
      nodes: [
        { id: 'R1', x: 70, y: 90, label: 'R1\nA::1' },
        { id: 'R2', x: 280, y: 90 },
        { id: 'R3', x: 490, y: 90, label: 'R3\nC::1' },
      ],
      edges: [['R1', 'R2'], ['R2', 'R3']],
    }
    return { net, consoles, layout }
  },

  tasks: [
    {
      id: 'routing-on',
      text: 'Enable IPv6 unicast routing on R1, R2 and R3',
      hints: ['A router will not forward IPv6 at all until unicast routing is switched on — it is off by default, unlike IPv4.',
        'R1(config)# ipv6 unicast-routing   (on all three)'],
      check: (net) =>
        ipv6RoutingOn(net, 'R1') && ipv6RoutingOn(net, 'R2') && ipv6RoutingOn(net, 'R3'),
    },
    {
      id: 'r1-default',
      text: 'R1: add an IPv6 default route toward R2 (2001:DB8:ACAD:12::2)',
      hints: ['The IPv6 default is ::/0 — the same idea as 0.0.0.0/0.',
        'R1(config)# ipv6 route ::/0 2001:DB8:ACAD:12::2'],
      check: (net) => hasIpv6Route(net, 'R1', '::/0', { nextHop: '2001:DB8:ACAD:12::2' }),
    },
    {
      id: 'r2-to-lan-a',
      text: `R2: add a route to LAN A (${LAN_A}/64) via R1`,
      hints: ['R2 is in the middle, so it needs a specific route to each LAN.',
        `R2(config)# ipv6 route ${LAN_A}/64 2001:DB8:ACAD:12::1`],
      check: (net) => hasIpv6Route(net, 'R2', `${LAN_A}/64`, { nextHop: '2001:DB8:ACAD:12::1' }),
    },
    {
      id: 'r2-to-lan-c',
      text: `R2: add a route to LAN C (${LAN_C}/64) via R3`,
      hints: ['Same again, for the far LAN, via R3.',
        `R2(config)# ipv6 route ${LAN_C}/64 2001:DB8:ACAD:23::2`],
      check: (net) => hasIpv6Route(net, 'R2', `${LAN_C}/64`, { nextHop: '2001:DB8:ACAD:23::2' }),
    },
    {
      id: 'r3-default',
      text: 'R3: add an IPv6 default route toward R2 (2001:DB8:ACAD:23::1)',
      hints: ['Mirror of R1, pointing back at R2.',
        'R3(config)# ipv6 route ::/0 2001:DB8:ACAD:23::1'],
      check: (net) => hasIpv6Route(net, 'R3', '::/0', { nextHop: '2001:DB8:ACAD:23::1' }),
    },
    {
      id: 'route-check',
      text: 'Verify: run show ipv6 route on R2 — both LAN prefixes are installed as static',
      hints: ['The IPv6 table marks connected prefixes C and static ones S, same as IPv4.',
        'R2# show ipv6 route'],
      check: (net) => {
        const a = ipv6RouteVia(net, 'R2', `${LAN_A}1`)
        const c = ipv6RouteVia(net, 'R2', R3_LAN_C)
        return !!a && a.proto === 'S' && !!c && c.proto === 'S' &&
          observedShow(net, 'R2', 'ipv6 route')
      },
    },
    {
      id: 'ping',
      text: `Verify: from R1, ping LAN C (${R3_LAN_C}) — it replies`,
      hints: ['End to end needs a path there AND back: R1 default, R2 specifics, R3 default.',
        `R1# ping ${R3_LAN_C}`],
      check: (net) => ipv6PingWorks(net, 'R1', R3_LAN_C) &&
        observedShow(net, 'R1', `ping ${R3_LAN_C.toLowerCase()}`),
    },
    {
      id: 'save',
      text: 'Save the configuration on R1, R2 and R3',
      hints: ['Persist on all three.', 'R1# write memory'],
      check: (net) => isSaved(net, 'R1') && isSaved(net, 'R2') && isSaved(net, 'R3'),
    },
  ],
}
