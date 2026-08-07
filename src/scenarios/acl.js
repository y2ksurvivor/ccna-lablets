// Lablet: Access Control Lists (blueprint 5.6).
//
// Topology:  PC1 .10 ┐
//                     ├─ R1 ── SERVER .100   (192.168.2.0/24)
//            PC2 .20 ┘   (192.168.1.0/24)
//
// Block PC2 from the server with a standard ACL, but let PC1 through. Standard
// ACLs match on source and go closest to the destination — apply it outbound
// on R1's server-facing interface.

import { createNetwork, addDevice, addLink } from '../engine/network.js'
import { createDevice, createHost, getInterface, resetCounters } from '../engine/device.js'
import { CLI } from '../engine/cli.js'
import { HostCLI } from '../engine/hostcli.js'
import { pingWorks, aclAllows, aclBlocks, isSaved, observedPing, observedShow } from '../engine/grader.js'

const SERVER_IP = '192.168.2.100'
// ACL 10 is actually filtering on the server-facing interface. Both reachability
// steps require this: on an untouched lab PC1 can already reach the server, so
// "PC1 CAN reach" would otherwise be green before any work was done.
const aclApplied = (net) =>
  getInterface(net.devices.R1, 'GigabitEthernet0/1').accessGroupOut === '10'

function ip(dev, name, addr, mask) {
  const i = getInterface(dev, name)
  i.ip = addr; i.mask = mask; i.shutdown = false; i.lineProtocol = true
}

export const aclLab = {
  id: 'acl',
  title: 'Access Control Lists (standard)',
  blueprint: ['5.6 Access control lists (standard and extended)'],
  intro: [
    'PC1 and PC2 share a LAN; a server sits on another. Permit PC1 to the',
    'server but deny PC2 — using a numbered standard ACL.',
    '',
    'PC1 192.168.1.10   PC2 192.168.1.20   (R1 g0/0 = .1)',
    'SERVER 192.168.2.100            (R1 g0/1 = 192.168.2.1)',
    '',
    'Remember: standard ACLs filter by source and belong closest to the',
    'destination — apply it OUTBOUND on R1 g0/1. Verify with pings.',
  ],

  build() {
    resetCounters()
    const net = createNetwork()
    const r1 = addDevice(net, createDevice({ id: 'R1', kind: 'router', hostname: 'R1' }))
    const pc1 = addDevice(net, createHost({ id: 'PC1', hostname: 'PC1', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' }))
    const pc2 = addDevice(net, createHost({ id: 'PC2', hostname: 'PC2', ip: '192.168.1.20', mask: '255.255.255.0', gateway: '192.168.1.1' }))
    const srv = addDevice(net, createHost({ id: 'SERVER', hostname: 'SERVER', ip: '192.168.2.100', mask: '255.255.255.0', gateway: '192.168.2.1' }))
    ip(r1, 'GigabitEthernet0/0', '192.168.1.1', '255.255.255.0')
    ip(r1, 'GigabitEthernet0/1', '192.168.2.1', '255.255.255.0')
    // Two PCs on one LAN via a small switch so both share g0/0.
    const sw = addDevice(net, createDevice({ id: 'SW1', kind: 'switch', hostname: 'SW1' }))
    for (const p of ['GigabitEthernet0/1', 'GigabitEthernet0/2', 'GigabitEthernet0/24']) getInterface(sw, p)
    addLink(net, 'PC1', 'NIC', 'SW1', 'GigabitEthernet0/1')
    addLink(net, 'PC2', 'NIC', 'SW1', 'GigabitEthernet0/2')
    addLink(net, 'SW1', 'GigabitEthernet0/24', 'R1', 'GigabitEthernet0/0')
    addLink(net, 'SERVER', 'NIC', 'R1', 'GigabitEthernet0/1')

    const consoles = {
      R1: new CLI(r1, net), SW1: new CLI(sw, net),
      PC1: new HostCLI(pc1, net), PC2: new HostCLI(pc2, net), SERVER: new HostCLI(srv, net),
    }
    const layout = {
      nodes: [
        { id: 'PC1', x: 30, y: 40, label: 'PC1\n.10' },
        { id: 'PC2', x: 30, y: 150, label: 'PC2\n.20' },
        { id: 'SW1', x: 180, y: 95 },
        { id: 'R1', x: 330, y: 95 },
        { id: 'SERVER', x: 480, y: 95, label: 'SERVER\n.100' },
      ],
      edges: [['PC1', 'SW1'], ['PC2', 'SW1'], ['SW1', 'R1'], ['R1', 'SERVER']],
    }
    return { net, consoles, layout }
  },

  tasks: [
    {
      id: 'acl-def',
      text: 'Build a standard ACL that denies PC2 (192.168.1.20) and permits everyone else',
      hints: ['Deny the one host, then permit the rest — order matters, and remember the implicit deny.',
        'access-list 10 deny host 192.168.1.20\naccess-list 10 permit any'],
      check: (net) => aclBlocks(net, 'R1', '10', '192.168.1.20') && aclAllows(net, 'R1', '10', '192.168.1.10'),
    },
    {
      id: 'acl-apply',
      text: 'Apply ACL 10 outbound on R1 g0/1 (the server-facing interface)',
      hints: ['Standard ACLs go closest to the destination — outbound on the interface toward the server.',
        'interface gi0/1 → ip access-group 10 out'],
      check: (net) => aclApplied(net),
    },
    {
      id: 'pc1-ok',
      text: `Verify: ping the server from PC1 — it still gets through`,
      hints: ['PC1 is permitted, so this should succeed — prove the ACL did not over-block.',
        `PC1> ping ${SERVER_IP}`],
      check: (net) => aclApplied(net) && pingWorks(net, 'PC1', SERVER_IP) &&
        observedPing(net, 'PC1', SERVER_IP),
    },
    {
      id: 'pc2-blocked',
      text: `Verify: ping the server from PC2 — it times out`,
      hints: ['PC2 is denied by the ACL, so this must fail (Request timed out).',
        `PC2> ping ${SERVER_IP}`],
      check: (net) => aclApplied(net) && !pingWorks(net, 'PC2', SERVER_IP) &&
        observedPing(net, 'PC2', SERVER_IP),
    },
    {
      id: 'acl-ext-def',
      text: 'Build extended ACL 100: permit PC1 to the server, deny PC2 to the server',
      hints: ['Extended ACLs match source AND destination, so the policy can name the server explicitly instead of every source.',
        `access-list 100 permit ip host 192.168.1.10 host ${SERVER_IP}\naccess-list 100 deny ip host 192.168.1.20 host ${SERVER_IP}`],
      check: (net) =>
        aclAllows(net, 'R1', '100', '192.168.1.10', SERVER_IP) &&
        aclBlocks(net, 'R1', '100', '192.168.1.20', SERVER_IP),
    },
    {
      id: 'acl-ext-apply',
      text: 'Apply ACL 100 inbound on R1 g0/0 (extended ACLs go closest to the source)',
      hints: ['Unlike a standard ACL, an extended one can sit near the source without over-blocking, because it matches the destination too.',
        'interface gi0/0 → ip access-group 100 in'],
      check: (net) => getInterface(net.devices.R1, 'GigabitEthernet0/0').accessGroupIn === '100',
    },
    {
      id: 'acl-verify',
      text: 'Verify: run show access-lists on R1 — both the standard and extended list are present',
      hints: ['Read the lists back to check the order of entries — order decides the outcome.',
        'R1# show access-lists'],
      check: (net) =>
        (net.devices.R1.acls['10'] || []).length > 0 &&
        (net.devices.R1.acls['100'] || []).length > 0 &&
        observedShow(net, 'R1', 'access-lists'),
    },
    {
      id: 'save',
      text: 'Save the configuration on R1',
      hints: ['Persist to startup.', 'R1# write memory'],
      check: (net) => isSaved(net, 'R1'),
    },
  ],
}
