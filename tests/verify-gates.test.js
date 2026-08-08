// Every "Verify: ..." task must require the learner to actually run the
// verification command. Without that gate these tasks turned green the moment
// the config was right, so the last step of a lablet was already complete before
// the learner did anything — which is what this suite guards against.
//
// Per lablet: apply the whole config but NOT the verification command, assert the
// gated tasks are still open and nothing else is, then run the verification
// command(s) and assert the lablet reaches 100%.

import { describe, it, expect } from 'vitest'
import { scenarios, getScenario } from '../src/scenarios/index.js'
import { grade, scorePct } from '../src/engine/grader.js'

// config: device -> commands, run before grading. verify: device -> the
// verification commands that must be required. gated: task ids that must stay
// open until those commands run.
const CASES = {
  'ipv4-addressing': {
    gated: ['intf-check', 'ping'],
    config: {
      R1: ['enable', 'conf t',
        'interface gi0/0', 'ip address 192.168.50.1 255.255.255.192', 'no shutdown', 'exit',
        'interface gi0/1', 'ip address 192.168.50.65 255.255.255.192', 'no shutdown',
        'end', 'write memory'],
    },
    verify: { R1: ['show ip interface brief'], PC1: ['ping 192.168.50.74'] },
  },

  'ipv6-addressing': {
    gated: ['intf-check', 'ping'],
    config: {
      R1: ['enable', 'conf t', 'ipv6 unicast-routing', 'interface gi0/0',
        'ipv6 address 2001:DB8:ACAD:1::1/64', 'no shutdown', 'end', 'write memory'],
      R2: ['enable', 'conf t', 'ipv6 unicast-routing', 'interface gi0/0',
        'ipv6 address 2001:DB8:ACAD:1::2/64', 'no shutdown', 'end', 'write memory'],
    },
    verify: { R1: ['show ipv6 interface brief', 'ping 2001:DB8:ACAD:1::2'] },
  },

  'vlan-basics': {
    gated: ['trunk-check', 'ping10', 'ping20'],
    config: {
      SW1: ['enable', 'conf t', 'vlan 10', 'exit', 'vlan 20', 'exit', 'vlan 99', 'exit',
        'interface gi0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
        'interface gi0/2', 'switchport mode access', 'switchport access vlan 20', 'exit',
        'interface gi0/24', 'switchport mode trunk',
        'switchport trunk native vlan 99', 'end', 'write memory'],
      SW2: ['enable', 'conf t', 'vlan 10', 'exit', 'vlan 20', 'exit', 'vlan 99', 'exit',
        'interface gi0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
        'interface gi0/2', 'switchport mode access', 'switchport access vlan 20', 'exit',
        'interface gi0/24', 'switchport mode trunk',
        'switchport trunk native vlan 99', 'end', 'write memory'],
    },
    verify: {
      SW1: ['show interfaces trunk'], SW2: ['show interfaces trunk'],
      PC1: ['ping 192.168.10.20'], PC3: ['ping 192.168.20.40'],
    },
  },

  'discovery-protocols': {
    gated: ['cdp-verify', 'lldp-verify'],
    config: {
      SW1: ['enable', 'conf t', 'interface gi0/1', 'cdp enable', 'exit', 'lldp run', 'end'],
      SW2: ['enable', 'conf t', 'lldp run', 'end'],
    },
    verify: {
      SW1: ['show cdp neighbors', 'show lldp neighbors'],
      SW2: ['show lldp neighbors'],
    },
  },

  etherchannel: {
    gated: ['channel-up'],
    config: {
      SW1: ['enable', 'conf t', 'interface gi0/1', 'channel-group 1 mode active', 'exit',
        'interface gi0/2', 'channel-group 1 mode active', 'end'],
      SW2: ['enable', 'conf t', 'interface gi0/1', 'channel-group 1 mode active', 'exit',
        'interface gi0/2', 'channel-group 1 mode active', 'end'],
    },
    verify: { SW1: ['show etherchannel summary'], SW2: ['show etherchannel summary'] },
  },

  'static-routing': {
    gated: ['route-check', 'ping'],
    config: {
      R1: ['enable', 'conf t', 'ip route 0.0.0.0 0.0.0.0 10.1.12.2', 'end', 'write memory'],
      R2: ['enable', 'conf t', 'ip route 192.168.1.0 255.255.255.0 10.1.12.1',
        'ip route 192.168.3.0 255.255.255.0 10.1.23.2',
        'ip route 192.168.3.10 255.255.255.255 10.1.23.2', 'end', 'write memory'],
      R3: ['enable', 'conf t', 'ip route 0.0.0.0 0.0.0.0 10.1.23.1',
        'ip route 0.0.0.0 0.0.0.0 10.1.23.9 200', 'end', 'write memory'],
    },
    verify: { R2: ['show ip route'], R3: ['show ip route'], PC1: ['ping 192.168.3.10'] },
  },

  ospf: {
    gated: ['nbr-check', 'ping'],
    config: {
      R1: ['enable', 'conf t', 'router ospf 1', 'router-id 1.1.1.1',
        'network 10.1.12.0 0.0.0.3 area 0',
        'network 192.168.1.0 0.0.0.255 area 0', 'end', 'write memory'],
      R2: ['enable', 'conf t', 'router ospf 1', 'network 10.1.12.0 0.0.0.3 area 0',
        'network 10.1.23.0 0.0.0.3 area 0', 'end', 'write memory'],
      R3: ['enable', 'conf t', 'router ospf 1', 'network 10.1.23.0 0.0.0.3 area 0',
        'network 192.168.3.0 0.0.0.255 area 0', 'end', 'write memory'],
    },
    verify: { R2: ['show ip ospf neighbor'], PC1: ['ping 192.168.3.10'] },
  },

  nat: {
    gated: ['verify'],
    config: {
      R1: ['enable', 'conf t', 'interface gi0/0', 'ip nat inside', 'exit',
        'interface gi0/1', 'ip nat outside', 'exit',
        'ip nat inside source static 192.168.1.10 203.0.113.10', 'end', 'write memory'],
    },
    verify: { R1: ['show ip nat translations'] },
  },

  ntp: {
    gated: ['r2-sync', 'r3-sync'],
    config: {
      R1: ['enable', 'conf t', 'ntp master 3', 'end', 'write memory'],
      R2: ['enable', 'conf t', 'ntp server 10.0.12.1', 'end', 'write memory'],
      R3: ['enable', 'conf t', 'ntp server 10.0.13.1', 'end', 'write memory'],
    },
    // Deliberately different spellings — either legitimately verifies the clock.
    verify: { R2: ['show ntp status'], R3: ['show ntp associations'] },
  },

  dhcp: {
    gated: ['lease'],
    config: {
      R2: ['enable', 'conf t', 'ip dhcp excluded-address 192.168.1.1', 'ip dhcp pool LAN1',
        'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', 'end', 'write memory'],
      R1: ['enable', 'conf t', 'interface gi0/0', 'ip helper-address 10.0.12.2',
        'end', 'write memory'],
    },
    verify: { PC1: ['ipconfig'] },
  },

  ssh: {
    gated: ['verify'],
    config: {
      R1: ['enable', 'conf t', 'ip domain-name lab.local', 'username admin secret cisco123',
        'crypto key generate rsa modulus 1024', 'line vty 0 4', 'transport input ssh',
        'login local', 'end', 'write memory'],
    },
    verify: { R1: ['show ip ssh'] },
  },

  acl: {
    gated: ['pc1-ok', 'pc2-blocked', 'acl-verify'],
    config: {
      R1: ['enable', 'conf t', 'access-list 10 deny host 192.168.1.20',
        'access-list 10 permit any', 'interface gi0/1', 'ip access-group 10 out', 'exit',
        'access-list 100 permit ip host 192.168.1.10 host 192.168.2.100',
        'access-list 100 deny ip host 192.168.1.20 host 192.168.2.100',
        'interface gi0/0', 'ip access-group 100 in',
        'end', 'write memory'],
    },
    verify: {
      R1: ['show access-lists'],
      PC1: ['ping 192.168.2.100'], PC2: ['ping 192.168.2.100'],
    },
  },

  'l2-security': {
    gated: ['portsec-check'],
    config: {
      SW1: ['enable', 'conf t',
        'interface gi0/1', 'switchport port-security',
        'switchport port-security maximum 1', 'switchport port-security mac-address sticky',
        'switchport port-security violation shutdown', 'exit',
        'interface gi0/2', 'switchport port-security',
        'switchport port-security maximum 1', 'switchport port-security mac-address sticky',
        'switchport port-security violation shutdown', 'exit',
        'ip dhcp snooping', 'ip dhcp snooping vlan 10',
        'interface gi0/24', 'ip dhcp snooping trust', 'exit',
        'ip arp inspection vlan 10', 'end', 'write memory'],
    },
    verify: { SW1: ['show port-security'] },
  },
}

const run = (sim, plan) => {
  for (const [dev, cmds] of Object.entries(plan)) {
    if (!sim.consoles[dev]) throw new Error(`no console for ${dev}`)
    for (const cmd of cmds) sim.consoles[dev].execute(cmd)
  }
}

describe.each(Object.entries(CASES))('%s', (id, c) => {
  const fresh = () => {
    const sc = getScenario(id)
    return { sc, sim: sc.build() }
  }

  it('fresh lablet has no task already complete', () => {
    const { sc, sim } = fresh()
    const green = grade(sc, sim.net).filter(t => t.pass).map(t => t.id)
    expect(green).toEqual([])
  })

  it('config alone leaves the verification steps open, and only those', () => {
    const { sc, sim } = fresh()
    run(sim, c.config)
    const r = grade(sc, sim.net)
    const open = r.filter(t => !t.pass).map(t => t.id)
    expect(open.sort()).toEqual([...c.gated].sort())
  })

  it('reaches 100% once the verification commands run', () => {
    const { sc, sim } = fresh()
    run(sim, c.config)
    run(sim, c.verify)
    const r = grade(sc, sim.net)
    expect(r.filter(t => t.error)).toEqual([])
    expect(scorePct(r)).toBe(100)
  })

  const devices = Object.keys(c.verify)
  if (devices.length > 1) {
    it('verifying only one end is not enough', () => {
      const { sc, sim } = fresh()
      run(sim, c.config)
      run(sim, { [devices[0]]: c.verify[devices[0]] })
      expect(scorePct(grade(sc, sim.net))).toBeLessThan(100)
    })
  }
})

describe('all lablets', () => {
  it('build and grade cleanly from scratch', () => {
    for (const s of scenarios) {
      const r = grade(s, s.build().net)
      expect(r.filter(t => t.error), `${s.id} grader errors`).toEqual([])
      expect(scorePct(r), `${s.id} should start at 0%`).toBe(0)
    }
  })

  it('every task labelled "Verify" is covered by a case above', () => {
    const uncovered = []
    for (const s of scenarios) {
      for (const t of s.tasks) {
        if (!/^Verify\b/i.test(t.text)) continue
        if (!CASES[s.id]?.gated.includes(t.id)) uncovered.push(`${s.id}/${t.id}`)
      }
    }
    expect(uncovered).toEqual([])
  })
})

// A check is "loose" when a configuration the task did not ask for still turns
// it green. Each case here is one that used to pass and must not.
describe('checks reject configurations the task did not ask for', () => {
  const build = (id, plan) => {
    const sc = getScenario(id)
    const sim = sc.build()
    for (const [dev, cmds] of Object.entries(plan)) {
      for (const c of cmds) sim.consoles[dev].execute(c)
    }
    return grade(sc, sim.net)
  }
  const passed = (results, id) => results.find(t => t.id === id).pass

  const bundle = (mode) => ({
    SW1: ['enable', 'conf t', 'interface gi0/1', `channel-group 1 mode ${mode}`, 'exit',
      'interface gi0/2', `channel-group 1 mode ${mode}`, 'end'],
  })

  it.each(['active', 'passive'])('EtherChannel accepts LACP mode %s', (mode) => {
    expect(passed(build('etherchannel', bundle(mode)), 'sw1-bundle')).toBe(true)
  })

  it('EtherChannel rejects mode on — static bundling is not LACP', () => {
    expect(passed(build('etherchannel', bundle('on')), 'sw1-bundle')).toBe(false)
  })

  it('a default route is required where the task says default (3.3.a)', () => {
    const specific = build('static-routing',
      { R1: ['enable', 'conf t', 'ip route 192.168.3.0 255.255.255.0 10.1.12.2', 'end'] })
    expect(passed(specific, 'r1-default')).toBe(false)
    const real = build('static-routing',
      { R1: ['enable', 'conf t', 'ip route 0.0.0.0 0.0.0.0 10.1.12.2', 'end'] })
    expect(passed(real, 'r1-default')).toBe(true)
  })

  it('a network route is required where the task says network (3.3.b)', () => {
    const dflt = build('static-routing',
      { R2: ['enable', 'conf t', 'ip route 0.0.0.0 0.0.0.0 10.1.12.1', 'end'] })
    expect(passed(dflt, 'r2-to-lan1')).toBe(false)
    expect(passed(dflt, 'r2-to-lan3')).toBe(false)
  })

  it('the IPv6 prefix length must match (1.8 is addressing AND prefix)', () => {
    const v6 = (len) => build('ipv6-addressing', {
      R1: ['enable', 'conf t', 'interface gi0/0',
        `ipv6 address 2001:DB8:ACAD:1::1/${len}`, 'no shutdown', 'end'],
    })
    expect(passed(v6(64), 'r1-addr')).toBe(true)
    expect(passed(v6(48), 'r1-addr')).toBe(false)
  })

  it('the DHCP pool mask must match', () => {
    const pool = (mask) => build('dhcp', {
      R2: ['enable', 'conf t', 'ip dhcp pool LAN1',
        `network 192.168.1.0 ${mask}`, 'default-router 192.168.1.1', 'end'],
    })
    expect(passed(pool('255.255.255.0'), 'pool')).toBe(true)
    expect(passed(pool('255.255.0.0'), 'pool')).toBe(false)
  })
})
