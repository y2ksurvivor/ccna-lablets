// Lablet: Remote access with SSH (blueprint 4.8).
//
// Topology:  ADMIN-PC ── R1 (configure R1 for SSH management)

import { createNetwork, addDevice, addLink } from '../engine/network.js'
import { createDevice, createHost, getInterface, resetCounters } from '../engine/device.js'
import { CLI } from '../engine/cli.js'
import { HostCLI } from '../engine/hostcli.js'
import { sshReady, isSaved } from '../engine/grader.js'

export const sshLab = {
  id: 'ssh',
  title: 'Remote Access with SSH',
  blueprint: ['4.8 SSH remote access'],
  intro: [
    'Secure R1 for remote management over SSHv2 (no Telnet).',
    '',
    'Steps: set a domain name, create a local user, generate RSA keys, and',
    'lock the VTY lines to SSH with local login.',
    '',
    'Verify with: show ip ssh   and   show running-config',
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
      nodes: [{ id: 'ADMIN', x: 120, y: 90, label: 'ADMIN\n.0.10' }, { id: 'R1', x: 340, y: 90 }],
      edges: [['ADMIN', 'R1']],
    }
    return { net, consoles, layout }
  },

  tasks: [
    {
      id: 'domain',
      text: 'Set a domain name on R1 (needed to generate keys)',
      hints: ['SSH keys are named host.domain — set the domain first.', 'R1(config)# ip domain-name lab.local'],
      check: (net) => !!net.devices.R1.domainName,
    },
    {
      id: 'user',
      text: 'Create a local username with a secret',
      hints: ['SSH with local login needs a local account to authenticate against.', 'R1(config)# username admin secret cisco123'],
      check: (net) => net.devices.R1.users.length > 0,
    },
    {
      id: 'keys',
      text: 'Generate RSA crypto keys',
      hints: ['This creates the key pair SSH uses. Requires the domain name to be set.', 'R1(config)# crypto key generate rsa modulus 1024'],
      check: (net) => !!net.devices.R1.rsaKey,
    },
    {
      id: 'vty',
      text: 'On the VTY lines, allow only SSH and use local login',
      hints: ['Restrict the virtual terminals to SSH and check credentials against the local user database.',
        'line vty 0 4 → transport input ssh → login local'],
      check: (net) => {
        const vty = net.devices.R1.lines.vty || {}
        return (vty.transportInput || []).includes('ssh') && vty.login === 'local'
      },
    },
    {
      id: 'verify',
      text: 'Verify: SSH is fully enabled on R1',
      hints: ['All pieces together — domain, user, keys, and SSH-only VTY with local login.', 'R1# show ip ssh'],
      check: (net) => sshReady(net, 'R1'),
    },
    {
      id: 'save',
      text: 'Save the configuration on R1',
      hints: ['Persist to startup.', 'R1# write memory'],
      check: (net) => isSaved(net, 'R1'),
    },
  ],
}
