// Lablet: EtherChannel with LACP (blueprint 2.4).
//
// Topology:   [SW1] ══ Gi0/1 & Gi0/2 ══ [SW2]   (two parallel links)
//
// Bundle the two links between SW1 and SW2 into one logical EtherChannel using
// LACP, on both switches, and verify the channel comes up.

import { createNetwork, addDevice, addLink } from '../engine/network.js'
import { createDevice, getInterface, resetCounters } from '../engine/device.js'
import { CLI } from '../engine/cli.js'
import { portInChannel, channelUp, observedShow } from '../engine/grader.js'

export const etherchannel = {
  id: 'etherchannel',
  title: 'EtherChannel (LACP)',
  blueprint: ['2.4 EtherChannel (LACP)'],
  intro: [
    'SW1 and SW2 are joined by two links: Gi0/1 and Gi0/2. Right now they are',
    'two separate links. Bundle them into a single logical EtherChannel using',
    'LACP so they act as one high-bandwidth trunk with no loop.',
    '',
    'Goals:',
    ' 1. On SW1, add Gi0/1 and Gi0/2 to channel-group 1 with LACP.',
    ' 2. On SW2, do the same so the far end negotiates.',
    ' 3. Verify the EtherChannel (Po1) is bundled/up.',
    '',
    'Verify with: show etherchannel summary   (look for Po1(SU) and (P) on ports)',
  ],

  build() {
    resetCounters()
    const net = createNetwork()
    const sw1 = addDevice(net, createDevice({ id: 'SW1', kind: 'switch', hostname: 'SW1' }))
    const sw2 = addDevice(net, createDevice({ id: 'SW2', kind: 'switch', hostname: 'SW2' }))
    for (const p of ['GigabitEthernet0/1', 'GigabitEthernet0/2']) {
      getInterface(sw1, p); getInterface(sw2, p)
    }
    addLink(net, 'SW1', 'GigabitEthernet0/1', 'SW2', 'GigabitEthernet0/1')
    addLink(net, 'SW1', 'GigabitEthernet0/2', 'SW2', 'GigabitEthernet0/2')

    const consoles = { SW1: new CLI(sw1, net), SW2: new CLI(sw2, net) }
    const layout = {
      nodes: [
        { id: 'SW1', x: 160, y: 90 },
        { id: 'SW2', x: 400, y: 90 },
      ],
      edges: [['SW1', 'SW2'], ['SW1', 'SW2']],
    }
    return { net, consoles, layout }
  },

  tasks: [
    {
      id: 'sw1-bundle',
      text: 'On SW1, add Gi0/1 and Gi0/2 to channel-group 1 (LACP)',
      hints: ['Put BOTH links into the same channel-group number, using an LACP mode.',
        'interface gi0/1 → channel-group 1 mode active   (repeat for gi0/2)'],
      check: (net) =>
        portInChannel(net, 'SW1', 'gi0/1', 1, { protocol: 'lacp' }) &&
        portInChannel(net, 'SW1', 'gi0/2', 1, { protocol: 'lacp' }),
    },
    {
      id: 'sw2-bundle',
      text: 'On SW2, add Gi0/1 and Gi0/2 to channel-group 1 (LACP)',
      hints: ['The far end must negotiate too — repeat the bundle on SW2.',
        'interface gi0/1 → channel-group 1 mode active   (repeat for gi0/2)'],
      check: (net) =>
        portInChannel(net, 'SW2', 'gi0/1', 1, { protocol: 'lacp' }) &&
        portInChannel(net, 'SW2', 'gi0/2', 1, { protocol: 'lacp' }),
    },
    {
      id: 'channel-up',
      text: 'Verify: run show etherchannel summary on SW1 and SW2 — Po1 is (SU) with both ports (P)',
      hints: ['LACP only bundles if the two sides\' modes are compatible. Two passive ends never start negotiation — at least one must be active. Then check the summary on each switch — each one only reports its own view.',
        'On SW1: show etherchannel summary → Po1(SU) means Layer 2 and in use; each port should show (P) for bundled. Then the same on SW2.'],
      // Gated on the show command as well as the state: a verification step you
      // never ran isn't verification. Each switch only reports its own side, so
      // "both ends" means running it on both.
      check: (net) =>
        channelUp(net, 'SW1', 1) && channelUp(net, 'SW2', 1) &&
        observedShow(net, 'SW1', 'etherchannel summary') &&
        observedShow(net, 'SW2', 'etherchannel summary'),
    },
  ],
}
