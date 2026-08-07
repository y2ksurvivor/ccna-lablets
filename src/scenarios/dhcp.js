// Lablet: DHCP server + relay (blueprint 4.6).
//
// Topology:  PC1(dhcp) ── R1(relay) ══ R2(DHCP server)
//
// R2 hosts the address pool; R1 relays the PC's broadcast to R2 with
// ip helper-address. Verify the PC receives a lease in the right subnet.

import { createNetwork, addDevice, addLink } from '../engine/network.js'
import { createDevice, createHost, getInterface, resetCounters } from '../engine/device.js'
import { CLI } from '../engine/cli.js'
import { HostCLI } from '../engine/hostcli.js'
import { dhcpLeaseInSubnet, isSaved, observedShow } from '../engine/grader.js'

function ip(dev, name, addr, mask) {
  const i = getInterface(dev, name)
  i.ip = addr; i.mask = mask; i.shutdown = false; i.lineProtocol = true
}

export const dhcpLab = {
  id: 'dhcp',
  title: 'DHCP Server & Relay',
  blueprint: ['4.6 DHCP (server pool & relay)'],
  intro: [
    'PC1 has no IP — it needs one from DHCP. The server lives on R2, one hop',
    'away, so R1 must relay PC1\'s request across the link.',
    '',
    'PC1 LAN 192.168.1.0/24 (R1 g0/0 = .1)   R1–R2 10.0.12.0/30 (R1 .1, R2 .2)',
    '',
    'Build the pool on R2, add the relay on R1, then verify PC1\'s lease.',
    'Verify with: on PC1, ipconfig  (after DHCP resolves).',
  ],

  build() {
    resetCounters()
    const net = createNetwork()
    const r1 = addDevice(net, createDevice({ id: 'R1', kind: 'router', hostname: 'R1' }))
    const r2 = addDevice(net, createDevice({ id: 'R2', kind: 'router', hostname: 'R2' }))
    const pc1 = addDevice(net, createHost({ id: 'PC1', hostname: 'PC1', ip: null, mask: null, gateway: null }))
    ip(r1, 'GigabitEthernet0/0', '192.168.1.1', '255.255.255.0')
    ip(r1, 'GigabitEthernet0/1', '10.0.12.1', '255.255.255.252')
    ip(r2, 'GigabitEthernet0/1', '10.0.12.2', '255.255.255.252')
    // R2 needs a route back to the client LAN for real replies (pre-seeded).
    r2.routes.push({ proto: 'S', prefix: '192.168.1.0', mask: '255.255.255.0', nextHop: '10.0.12.1', ad: 1, metric: 0 })
    addLink(net, 'PC1', 'NIC', 'R1', 'GigabitEthernet0/0')
    addLink(net, 'R1', 'GigabitEthernet0/1', 'R2', 'GigabitEthernet0/1')

    const consoles = { R1: new CLI(r1, net), R2: new CLI(r2, net), PC1: new HostCLI(pc1, net) }
    const layout = {
      nodes: [
        { id: 'PC1', x: 40, y: 90, label: 'PC1\ndhcp' },
        { id: 'R1', x: 220, y: 90 },
        { id: 'R2', x: 430, y: 90, label: 'R2\nserver' },
      ],
      edges: [['PC1', 'R1'], ['R1', 'R2']],
    }
    return { net, consoles, layout }
  },

  tasks: [
    {
      id: 'pool',
      text: 'On R2, create a DHCP pool for 192.168.1.0/24 with default-router 192.168.1.1',
      hints: ['Define the pool network and the gateway clients should use.',
        'R2(config)# ip dhcp pool LAN1 → network 192.168.1.0 255.255.255.0 → default-router 192.168.1.1'],
      check: (net) => {
        const p = Object.values(net.devices.R2.dhcpPools)[0]
        return !!(p && p.network === '192.168.1.0' && p.defaultRouter === '192.168.1.1')
      },
    },
    {
      id: 'exclude',
      text: 'On R2, exclude the gateway address 192.168.1.1 from the pool',
      hints: ['Reserve the router\'s own IP so DHCP never hands it out.',
        'R2(config)# ip dhcp excluded-address 192.168.1.1'],
      check: (net) => net.devices.R2.dhcpExcluded.includes('192.168.1.1'),
    },
    {
      id: 'relay',
      text: 'On R1 g0/0, add a DHCP relay pointing at R2 (10.0.12.2)',
      hints: ['The server is on another subnet, so R1 must forward the broadcast to it.',
        'R1(config)# interface gi0/0 → ip helper-address 10.0.12.2'],
      check: (net) => getInterface(net.devices.R1, 'GigabitEthernet0/0').helperAddress === '10.0.12.2',
    },
    {
      id: 'lease',
      text: 'Verify: run ipconfig on PC1 — it holds a lease in 192.168.1.0/24',
      hints: ['With pool + relay in place, PC1\'s request reaches R2 and gets an address. Confirm it from the client.',
        'PC1> ipconfig'],
      // Gated on the client actually reading its address — the state check alone
      // is the AND of the pool + relay config tasks.
      check: (net) => dhcpLeaseInSubnet(net, 'PC1', '192.168.1.0', '255.255.255.0') &&
        observedShow(net, 'PC1', 'ipconfig'),
    },
    {
      id: 'save',
      text: 'Save the configuration on R1 and R2',
      hints: ['Persist on both.', 'R1# write memory'],
      check: (net) => isSaved(net, 'R1') && isSaved(net, 'R2'),
    },
  ],
}
