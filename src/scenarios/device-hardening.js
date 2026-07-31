// Lablet: Device access control with local passwords (blueprint 5.3).
//
// Topology:  ADMIN ── R1   (secure console + VTY + privileged EXEC on R1)

import { createNetwork, addDevice, addLink } from '../engine/network.js'
import { createDevice, createHost, getInterface, resetCounters } from '../engine/device.js'
import { CLI } from '../engine/cli.js'
import { HostCLI } from '../engine/hostcli.js'
import { hasEnableSecret, lineSecured, servicePwEncryption, isSaved } from '../engine/grader.js'

export const deviceHardening = {
  id: 'device-hardening',
  title: 'Device Access Control (local passwords)',
  blueprint: ['5.3 Device access control (local passwords)'],
  intro: [
    'Harden R1 with local passwords so it is not wide open.',
    '',
    'Goals: secret on privileged EXEC, a password + login on the console line,',
    'a password + login on the VTY lines, and encrypt the plaintext passwords.',
    '',
    'Verify with: show running-config',
  ],

  build() {
    resetCounters()
    const net = createNetwork()
    const r1 = addDevice(net, createDevice({ id: 'R1', kind: 'router', hostname: 'R1' }))
    const pc = addDevice(net, createHost({ id: 'ADMIN', hostname: 'ADMIN', ip: '10.0.0.10', mask: '255.255.255.0', gateway: '10.0.0.1' }))
    const g0 = getInterface(r1, 'GigabitEthernet0/0')
    g0.ip = '10.0.0.1'; g0.mask = '255.255.255.0'; g0.shutdown = false; g0.lineProtocol = true
    addLink(net, 'ADMIN', 'NIC', 'R1', 'GigabitEthernet0/0')

    const consoles = { R1: new CLI(r1, net), ADMIN: new HostCLI(pc, net) }
    const layout = {
      nodes: [{ id: 'ADMIN', x: 120, y: 90, label: 'ADMIN' }, { id: 'R1', x: 340, y: 90 }],
      edges: [['ADMIN', 'R1']],
    }
    return { net, consoles, layout }
  },

  tasks: [
    {
      id: 'secret',
      text: 'Set an enable secret on R1',
      hints: ['Protect privileged EXEC with a hashed secret (not the weaker enable password).', 'R1(config)# enable secret cisco123'],
      check: (net) => hasEnableSecret(net, 'R1'),
    },
    {
      id: 'console',
      text: 'Secure the console line with a password and login',
      hints: ['Set a password on line con 0 and require login so it is actually enforced.',
        'line console 0 → password conpass → login'],
      check: (net) => lineSecured(net, 'R1', 'console'),
    },
    {
      id: 'vty',
      text: 'Secure the VTY lines with a password and login',
      hints: ['Same idea on the virtual terminals used for remote access.',
        'line vty 0 4 → password vtypass → login'],
      check: (net) => lineSecured(net, 'R1', 'vty'),
    },
    {
      id: 'encrypt',
      text: 'Encrypt the plaintext passwords in the config',
      hints: ['One global command scrambles the clear-text line/enable passwords in show run.',
        'R1(config)# service password-encryption'],
      check: (net) => servicePwEncryption(net, 'R1'),
    },
    {
      id: 'save',
      text: 'Save the configuration on R1',
      hints: ['Persist to startup.', 'R1# write memory'],
      check: (net) => isSaved(net, 'R1'),
    },
  ],
}
