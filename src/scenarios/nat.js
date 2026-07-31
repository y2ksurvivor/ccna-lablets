// Lablet: Inside source NAT — static (blueprint 4.1).
//
// Topology:  PC1(inside) ── R1(NAT) ══ ISP(outside)
//
// Map the inside host's private address to a public address with static NAT,
// mark the inside/outside interfaces, and verify the translation.

import { createNetwork, addDevice, addLink } from '../engine/network.js'
import { createDevice, createHost, getInterface, resetCounters } from '../engine/device.js'
import { CLI } from '../engine/cli.js'
import { HostCLI } from '../engine/hostcli.js'
import { ifaceNatRole, natReachable, isSaved } from '../engine/grader.js'

function ip(dev, name, addr, mask) {
  const i = getInterface(dev, name)
  i.ip = addr; i.mask = mask; i.shutdown = false; i.lineProtocol = true
}

export const natLab = {
  id: 'nat',
  title: 'Static NAT (inside source)',
  blueprint: ['4.1 Inside source NAT (static)'],
  intro: [
    'R1 is the border router. PC1 uses a private address that must be',
    'translated to a public one before reaching the ISP.',
    '',
    'Inside  LAN 192.168.1.0/24  PC1 = 192.168.1.10   (R1 g0/0 = .1)',
    'Outside link 203.0.113.0/30 ISP = 203.0.113.2    (R1 g0/1 = .1)',
    'Map inside-local 192.168.1.10  →  inside-global 203.0.113.10.',
    '',
    'Verify with: show ip nat translations',
  ],

  build() {
    resetCounters()
    const net = createNetwork()
    const r1 = addDevice(net, createDevice({ id: 'R1', kind: 'router', hostname: 'R1' }))
    const pc1 = addDevice(net, createHost({ id: 'PC1', hostname: 'PC1', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' }))
    const isp = addDevice(net, createHost({ id: 'ISP', hostname: 'ISP', ip: '203.0.113.2', mask: '255.255.255.252', gateway: '203.0.113.1' }))
    ip(r1, 'GigabitEthernet0/0', '192.168.1.1', '255.255.255.0')
    ip(r1, 'GigabitEthernet0/1', '203.0.113.1', '255.255.255.252')
    addLink(net, 'PC1', 'NIC', 'R1', 'GigabitEthernet0/0')
    addLink(net, 'ISP', 'NIC', 'R1', 'GigabitEthernet0/1')

    const consoles = { R1: new CLI(r1, net), PC1: new HostCLI(pc1, net), ISP: new HostCLI(isp, net) }
    const layout = {
      nodes: [
        { id: 'PC1', x: 40, y: 90, label: 'PC1\n.1.10' },
        { id: 'R1', x: 250, y: 90 },
        { id: 'ISP', x: 460, y: 90, label: 'ISP\n.113.2' },
      ],
      edges: [['PC1', 'R1'], ['R1', 'ISP']],
    }
    return { net, consoles, layout }
  },

  tasks: [
    {
      id: 'inside',
      text: 'Mark R1 g0/0 (LAN side) as ip nat inside',
      hints: ['The interface facing the private hosts is the inside.', 'R1(config)# interface gi0/0 → ip nat inside'],
      check: (net) => ifaceNatRole(net, 'R1', 'gi0/0', 'inside'),
    },
    {
      id: 'outside',
      text: 'Mark R1 g0/1 (ISP side) as ip nat outside',
      hints: ['The interface facing the ISP is the outside.', 'R1(config)# interface gi0/1 → ip nat outside'],
      check: (net) => ifaceNatRole(net, 'R1', 'gi0/1', 'outside'),
    },
    {
      id: 'static',
      text: 'Create a static NAT mapping 192.168.1.10 → 203.0.113.10',
      hints: ['Bind the inside-local address to its inside-global (public) address.',
        'R1(config)# ip nat inside source static 192.168.1.10 203.0.113.10'],
      check: (net) => net.devices.R1.nat.statics.some(s => s.insideLocal === '192.168.1.10' && s.insideGlobal === '203.0.113.10'),
    },
    {
      id: 'verify',
      text: 'Verify: the static translation is active and usable',
      hints: ['With inside/outside set and the static map in place, the translation exists.',
        'R1# show ip nat translations'],
      check: (net) => natReachable(net, 'R1', 'ISP', '192.168.1.10'),
    },
    {
      id: 'save',
      text: 'Save the configuration on R1',
      hints: ['Persist to startup.', 'R1# write memory'],
      check: (net) => isSaved(net, 'R1'),
    },
  ],
}
