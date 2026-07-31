// Lablet: NTP client/server (blueprint 4.2).
//
// Topology:   R2 ── R1 ── R3     (R1 is the time source)

import { createNetwork, addDevice, addLink } from '../engine/network.js'
import { createDevice, getInterface, resetCounters } from '../engine/device.js'
import { CLI } from '../engine/cli.js'
import { ntpIsSynced, isSaved } from '../engine/grader.js'

function ip(dev, name, addr, mask) {
  const i = getInterface(dev, name)
  i.ip = addr; i.mask = mask; i.shutdown = false; i.lineProtocol = true
}

export const ntpLab = {
  id: 'ntp',
  title: 'NTP Client & Server',
  blueprint: ['4.2 NTP client/server'],
  intro: [
    'R1 sits between R2 and R3 and will act as the network time source.',
    'Make R1 an NTP master, then point R2 and R3 at R1 so they synchronize.',
    '',
    'R1–R2 link 10.0.12.0/30 (R1 .1, R2 .2)',
    'R1–R3 link 10.0.13.0/30 (R1 .1, R3 .2)',
    '',
    'Verify with: show ntp associations  /  show ntp status',
  ],

  build() {
    resetCounters()
    const net = createNetwork()
    const r1 = addDevice(net, createDevice({ id: 'R1', kind: 'router', hostname: 'R1' }))
    const r2 = addDevice(net, createDevice({ id: 'R2', kind: 'router', hostname: 'R2' }))
    const r3 = addDevice(net, createDevice({ id: 'R3', kind: 'router', hostname: 'R3' }))
    ip(r1, 'GigabitEthernet0/1', '10.0.12.1', '255.255.255.252')
    ip(r1, 'GigabitEthernet0/2', '10.0.13.1', '255.255.255.252')
    ip(r2, 'GigabitEthernet0/1', '10.0.12.2', '255.255.255.252')
    ip(r3, 'GigabitEthernet0/1', '10.0.13.2', '255.255.255.252')
    addLink(net, 'R1', 'GigabitEthernet0/1', 'R2', 'GigabitEthernet0/1')
    addLink(net, 'R1', 'GigabitEthernet0/2', 'R3', 'GigabitEthernet0/1')

    const consoles = { R1: new CLI(r1, net), R2: new CLI(r2, net), R3: new CLI(r3, net) }
    const layout = {
      nodes: [
        { id: 'R2', x: 90, y: 90 },
        { id: 'R1', x: 300, y: 90 },
        { id: 'R3', x: 500, y: 90 },
      ],
      edges: [['R2', 'R1'], ['R1', 'R3']],
    }
    return { net, consoles, layout }
  },

  tasks: [
    {
      id: 'master',
      text: 'Make R1 an NTP master (time source)',
      hints: ['Tell R1 to serve time from its own clock.', 'R1(config)# ntp master 3'],
      check: (net) => net.devices.R1.ntp.master === true,
    },
    {
      id: 'r2-client',
      text: 'Point R2 at R1 (10.0.12.1) as its NTP server',
      hints: ['Configure R2 as an NTP client of R1.', 'R2(config)# ntp server 10.0.12.1'],
      check: (net) => net.devices.R2.ntp.servers.includes('10.0.12.1'),
    },
    {
      id: 'r3-client',
      text: 'Point R3 at R1 (10.0.13.1) as its NTP server',
      hints: ['Same for R3.', 'R3(config)# ntp server 10.0.13.1'],
      check: (net) => net.devices.R3.ntp.servers.includes('10.0.13.1'),
    },
    {
      id: 'r2-sync',
      text: 'Verify: R2 is synchronized to R1',
      hints: ['R2 syncs only if R1 is a master and reachable.', 'R2# show ntp status'],
      check: (net) => ntpIsSynced(net, 'R2'),
    },
    {
      id: 'r3-sync',
      text: 'Verify: R3 is synchronized to R1',
      hints: ['Same check on R3.', 'R3# show ntp status'],
      check: (net) => ntpIsSynced(net, 'R3'),
    },
    {
      id: 'save',
      text: 'Save the configuration on R1, R2, and R3',
      hints: ['Persist on all three.', 'R1# write memory'],
      check: (net) => isSaved(net, 'R1') && isSaved(net, 'R2') && isSaved(net, 'R3'),
    },
  ],
}
