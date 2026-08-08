// Lablet: IPv4 Static Routing with default routes (blueprint 3.3).
//
// Topology (all interface IPs pre-configured — you configure routing only):
//
//   PC1 ── R1 ══ R2 ══ R3 ── PC3
//   .1.10   g0/0 |g0/1  |g0/1  |g0/2  |g0/1  g0/0  .3.10
//
//   PC1 LAN 192.168.1.0/24 (R1 g0/0 = .1)
//   R1–R2 link 10.1.12.0/30  (R1=.1, R2=.2)
//   R2–R3 link 10.1.23.0/30  (R2=.1, R3=.2)
//   PC3 LAN 192.168.3.0/24 (R3 g0/0 = .1)

import { createNetwork, addDevice, addLink } from '../engine/network.js'
import { createDevice, createHost, getInterface, resetCounters } from '../engine/device.js'
import { CLI } from '../engine/cli.js'
import { HostCLI } from '../engine/hostcli.js'
import { pingWorks, isSaved, observedPing, observedShow,
  hasStaticRoute, routeVia } from '../engine/grader.js'

function ip(dev, name, addr, mask) {
  const i = getInterface(dev, name)
  i.ip = addr; i.mask = mask; i.shutdown = false; i.lineProtocol = true
  return i
}

export const staticRouting = {
  id: 'static-routing',
  title: 'Static Routing (with default routes)',
  blueprint: ['3.3 IPv4 static routing (default, network, host, and floating static)'],
  intro: [
    'Three routers in a line, each LAN with a PC. All interface IPs are already',
    'configured — your job is the routing so PC1 can reach PC3.',
    '',
    'PC1 LAN  192.168.1.0/24   R1–R2  10.1.12.0/30 (R1 .1, R2 .2)',
    'PC3 LAN  192.168.3.0/24   R2–R3  10.1.23.0/30 (R2 .1, R3 .2)',
    '',
    'Plan: default routes on the edge routers (R1, R3) pointing at R2, and',
    'specific routes on R2 back to each LAN.',
    '',
    'Verify with: show ip route  and  ping from PC1.',
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
      id: 'r1-default',
      text: 'R1: add a default route toward R2 (10.1.12.2)',
      hints: ['R1 only knows its two connected networks. Give it a default route to send everything else to R2.',
        'R1(config)# ip route 0.0.0.0 0.0.0.0 10.1.12.2'],
      // Must be a real default (3.3.a). routeCovers() alone also accepted a
      // specific route to the far LAN, which is a different blueprint item.
      check: (net) => hasStaticRoute(net, 'R1', '0.0.0.0', '0.0.0.0', { nextHop: '10.1.12.2' }),
    },
    {
      id: 'r2-to-lan1',
      text: 'R2: add a route to the PC1 LAN (192.168.1.0/24) via R1',
      hints: ['R2 sits in the middle — it needs an explicit route to each LAN.',
        'R2(config)# ip route 192.168.1.0 255.255.255.0 10.1.12.1'],
      // A specific network route (3.3.b) — a default that happens to cover the
      // LAN is not what this task asked for.
      check: (net) => hasStaticRoute(net, 'R2', '192.168.1.0', '255.255.255.0', { nextHop: '10.1.12.1' }),
    },
    {
      id: 'r2-to-lan3',
      text: 'R2: add a route to the PC3 LAN (192.168.3.0/24) via R3',
      hints: ['Same idea, for the far LAN, via R3.',
        'R2(config)# ip route 192.168.3.0 255.255.255.0 10.1.23.2'],
      check: (net) => hasStaticRoute(net, 'R2', '192.168.3.0', '255.255.255.0', { nextHop: '10.1.23.2' }),
    },
    {
      id: 'r3-default',
      text: 'R3: add a default route toward R2 (10.1.23.1)',
      hints: ['Mirror of R1 — a default route pointing back at R2.',
        'R3(config)# ip route 0.0.0.0 0.0.0.0 10.1.23.1'],
      check: (net) => hasStaticRoute(net, 'R3', '0.0.0.0', '0.0.0.0', { nextHop: '10.1.23.1' }),
    },
    {
      id: 'host-route',
      text: 'On R2, add a host route for PC3 (192.168.3.10/32) via R3 (10.1.23.2)',
      hints: ['A host route is just a static route with a /32 mask — the longest match possible, so it wins over the /24.',
        'R2(config)# ip route 192.168.3.10 255.255.255.255 10.1.23.2'],
      check: (net) => hasStaticRoute(net, 'R2', '192.168.3.10', '255.255.255.255',
        { nextHop: '10.1.23.2' }),
    },
    {
      id: 'floating-static',
      text: 'On R3, add a floating static default route via 10.1.23.9 with AD 200 (a standby path)',
      hints: ['A floating static is a backup: give it a worse administrative distance than the primary so it only installs if the primary disappears.',
        'R3(config)# ip route 0.0.0.0 0.0.0.0 10.1.23.9 200'],
      check: (net) => hasStaticRoute(net, 'R3', '0.0.0.0', '0.0.0.0', { ad: 200 }),
    },
    {
      id: 'route-check',
      text: 'Verify: run show ip route on R2 and R3 — the /32 is installed, and the AD 200 backup is not',
      hints: ['Only the best route per prefix gets installed, so the floating static should be absent from R3\'s table while the primary is up. The /32 on R2 should be there, below the /24.',
        'R2# show ip route   then R3# show ip route'],
      check: (net) => {
        const toPc3 = routeVia(net, 'R2', '192.168.3.10')
        const r3Default = routeVia(net, 'R3', '192.168.1.10')
        return !!toPc3 && toPc3.nextHop === '10.1.23.2' &&
          !!r3Default && r3Default.ad === 1 &&
          observedShow(net, 'R2', 'ip route') && observedShow(net, 'R3', 'ip route')
      },
    },
    {
      id: 'ping',
      text: 'Verify: PC1 can ping PC3 (192.168.3.10)',
      hints: ['Open PC1 and ping PC3. Needs a full path there AND back.',
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
