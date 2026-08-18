// The CLI must never accept a command silently and do the wrong thing, and must
// never silently do nothing. Both mislead the learner far worse than an error
// does — a lablet task just stays red with no explanation.

import { describe, it, expect } from 'vitest'
import { getScenario } from '../src/scenarios/index.js'
import { grade } from '../src/engine/grader.js'

const INVALID = /% Invalid input detected/

function router() {
  const sim = getScenario('ipv4-addressing').build()
  const cli = sim.consoles.R1
  for (const c of ['enable', 'conf t', 'interface gi0/0']) cli.execute(c)
  return { cli, ifc: () => sim.net.devices.R1.interfaces['GigabitEthernet0/0'] }
}

describe('no-argument commands reject trailing tokens', () => {
  it('"sh run" in interface config errors instead of shutting the port', () => {
    const { cli, ifc } = router()
    cli.execute('no shutdown')
    const out = cli.execute('sh run')
    expect(out.join('\n')).toMatch(INVALID)
    // The real damage: `sh` abbreviates `shutdown`, so without the arity check
    // this silently shut the interface and printed nothing at all.
    expect(ifc().shutdown).toBe(false)
  })

  it('the caret points at the offending token', () => {
    const { cli } = router()
    const [caret] = cli.execute('sh run')
    // The terminal echoes "<prompt><command>", so "run" starts at prompt+3 and
    // the caret must land on that column.
    expect(caret.indexOf('^')).toBe(cli.prompt().length + 'sh '.length)
    expect(caret.trim()).toBe('^')
  })

  it('bare "shutdown" and its abbreviation still work', () => {
    const { cli, ifc } = router()
    cli.execute('no shutdown')
    expect(cli.execute('shutdown').join('\n')).toMatch(/administratively down/)
    expect(ifc().shutdown).toBe(true)
    cli.execute('no shutdown')
    expect(cli.execute('sh').join('\n')).toMatch(/administratively down/)
    expect(ifc().shutdown).toBe(true)
  })

  it('"do show run" is unaffected', () => {
    const { cli } = router()
    expect(cli.execute('do sho run').join('\n')).toContain('Building configuration')
  })
})

describe('parse errors always use the IOS caret form', () => {
  // Every rejection should be a caret line + "at '^' marker.", with the caret on
  // the token that actually failed — not a bare "% Invalid input detected".
  const cases = [
    ['config', 'do sho rn', 'rn'],                       // unknown show subcommand
    ['config', 'do show ip bogus', 'bogus'],             // unknown sub-subcommand
    ['config', 'do sh int bogus', 'bogus'],
    ['config', 'do bogus', 'bogus'],                     // unknown command under `do`
    ['config', 'line bogus', 'bogus'],
    ['config', 'router bogus', 'bogus'],
    ['iface', 'ip access-group 10 sideways', 'sideways'],
    ['iface', 'channel-group 1 mode turbo', 'turbo'],
    ['iface', 'switchport bogus', 'bogus'],
    ['iface', 'ipv6 bogus', 'bogus'],
  ]

  it.each(cases)('[%s] %s flags "%s"', (mode, cmd, token) => {
    const sim = getScenario('vlan-basics').build()
    const cli = sim.consoles.SW1
    for (const c of ['enable', 'conf t']) cli.execute(c)
    if (mode === 'iface') cli.execute('interface gi0/1')

    const promptLen = cli.prompt().length
    const out = cli.execute(cmd)
    expect(out).toHaveLength(2)
    expect(out[1]).toBe("% Invalid input detected at '^' marker.")
    // The caret column must match where the token sits in the echoed line.
    expect(out[0].indexOf('^')).toBe(promptLen + cmd.indexOf(token))
  })

  it('no bare "% Invalid input detected" survives anywhere in the CLI', async () => {
    const src = await import('node:fs')
    const code = src.readFileSync(new URL('../src/engine/cli.js', import.meta.url), 'utf8')
    expect(code).not.toMatch(/'% Invalid input/)
  })
})

describe('show ip interface brief matches IOS layout', () => {
  const cli = () => {
    const sim = getScenario('ipv4-addressing').build()
    const c = sim.consoles.R1
    for (const cmd of ['enable', 'conf t', 'interface gi0/0',
      'ip address 192.168.50.1 255.255.255.192', 'no shutdown', 'end']) c.execute(cmd)
    return c
  }

  it('prints full interface names, not abbreviations', () => {
    const out = cli().execute('show ip interface brief')
    expect(out[1]).toMatch(/^GigabitEthernet0\/0 /)
    expect(out.join('\n')).not.toMatch(/^Gi0\//m)
  })

  it('uses fixed column widths so every row aligns', () => {
    const out = cli().execute('show ip interface brief')
    const header = out[0]
    // Each column starts at the same offset on every row.
    for (const col of ['IP-Address', 'OK?', 'Method', 'Status', 'Protocol']) {
      const at = header.indexOf(col)
      for (const row of out.slice(1)) {
        expect(row.charAt(at)).not.toBe(' ')
      }
    }
  })

  it('reports admin-down and unassigned interfaces', () => {
    const out = cli().execute('show ip interface brief').join('\n')
    expect(out).toMatch(/GigabitEthernet0\/1 +unassigned +YES unset +administratively down down/)
  })
})

describe('access ports must be explicitly configured', () => {
  const vlanLab = (cmds) => {
    const sim = getScenario('vlan-basics').build()
    for (const sw of ['SW1', 'SW2']) {
      for (const c of ['enable', 'conf t', 'vlan 10', 'exit', 'interface gi0/1',
        ...cmds, 'end']) sim.consoles[sw].execute(c)
    }
    return sim
  }
  const access10 = (sim) => grade(getScenario('vlan-basics'), sim.net)
    .find(t => t.id === 'access10').pass

  it('requires both switchport mode access and switchport access vlan', () => {
    expect(access10(vlanLab(['switchport mode access', 'switchport access vlan 10']))).toBe(true)
  })

  // Switch ports sit in access mode internally, so the VLAN command alone used
  // to satisfy a task whose text asks for both.
  it('is not satisfied by the vlan command alone', () => {
    expect(access10(vlanLab(['switchport access vlan 10']))).toBe(false)
  })

  it('is not satisfied by the mode command alone', () => {
    expect(access10(vlanLab(['switchport mode access']))).toBe(false)
  })

  it('running-config omits switchport mode access until it is configured', () => {
    const sim = getScenario('discovery-protocols').build()
    const cli = sim.consoles.SW1
    cli.execute('enable')
    expect(cli.execute('show run').join('\n')).not.toContain('switchport mode access')
    for (const c of ['conf t', 'interface gi0/1', 'switchport mode access', 'end']) cli.execute(c)
    expect(cli.execute('show run').join('\n')).toContain('switchport mode access')
  })
})

describe('fixed-arity commands reject trailing tokens', () => {
  // "switchport mode trunk native vlan 99" is two commands typed as one. Running
  // only the first half silently leaves the learner certain they configured a
  // native VLAN they never set.
  const iface = (id, dev, setup) => {
    const sim = getScenario(id).build()
    const cli = sim.consoles[dev]
    for (const c of setup) cli.execute(c)
    return { cli, sim }
  }

  const rejected = (out) => out.length === 2 &&
    out[1] === "% Invalid input detected at '^' marker."

  it('switchport mode trunk native vlan 99 is rejected and changes nothing', () => {
    const { cli, sim } = iface('vlan-basics', 'SW1',
      ['enable', 'conf t', 'interface gi0/24'])
    expect(rejected(cli.execute('switchport mode trunk native vlan 99'))).toBe(true)
    const ifc = sim.net.devices.SW1.interfaces['GigabitEthernet0/24']
    expect(ifc.modeExplicit).toBe(false)
    expect(ifc.trunkNativeVlan).toBe(1)
  })

  it('switchport mode access vlan 10 is rejected and changes nothing', () => {
    const { cli, sim } = iface('vlan-basics', 'SW1',
      ['enable', 'conf t', 'interface gi0/1'])
    expect(rejected(cli.execute('switchport mode access vlan 10'))).toBe(true)
    const ifc = sim.net.devices.SW1.interfaces['GigabitEthernet0/1']
    expect(ifc.modeExplicit).toBe(false)
    expect(ifc.accessVlan).toBe(1)
  })

  it.each([
    ['vlan-basics', 'SW1', ['enable', 'conf t', 'interface gi0/1'], 'switchport access vlan 10 bogus'],
    ['vlan-basics', 'SW1', ['enable', 'conf t', 'interface gi0/24'], 'switchport trunk native vlan 99 bogus'],
    ['l2-security', 'SW1', ['enable', 'conf t', 'interface gi0/1'], 'switchport port-security maximum 1 bogus'],
    ['ipv4-addressing', 'R1', ['enable', 'conf t', 'interface gi0/0'], 'ip address 10.0.0.1 255.255.255.0 bogus'],
    ['etherchannel', 'SW1', ['enable', 'conf t', 'interface gi0/1'], 'channel-group 1 mode active bogus'],
    ['dhcp', 'R1', ['enable', 'conf t', 'interface gi0/0'], 'ip helper-address 10.0.12.2 bogus'],
    ['ssh', 'R1', ['enable', 'conf t'], 'ip domain-name lab.local bogus'],
    ['vlan-basics', 'SW1', ['enable', 'conf t'], 'vlan 10 bogus'],
    ['static-routing', 'R1', ['enable', 'conf t'], 'ip route 0.0.0.0 0.0.0.0 10.1.12.2 200 bogus'],
  ])('%s: %s', (id, dev, setup, cmd) => {
    const { cli } = iface(id, dev, setup)
    expect(rejected(cli.execute(cmd))).toBe(true)
  })

  it.each([
    ['switchport mode trunk'],
    ['switchport trunk native vlan 99'],
    ['switchport trunk allowed vlan 10,20'],
    ['switchport mode access'],
    ['switchport access vlan 10'],
    ['switchport port-security'],
    ['switchport port-security maximum 2'],
    ['switchport port-security mac-address sticky'],
    ['switchport port-security violation restrict'],
  ])('the real command still works: %s', (cmd) => {
    const { cli } = iface('l2-security', 'SW1', ['enable', 'conf t', 'interface gi0/1'])
    expect(cli.execute(cmd)).toEqual([])
  })

  it('description stays free-form', () => {
    const { cli } = iface('ipv4-addressing', 'R1', ['enable', 'conf t', 'interface gi0/0'])
    expect(cli.execute('description uplink to the SALES vlan')).toEqual([])
  })
})

describe('interface counters', () => {
  const routed = () => {
    const sim = getScenario('static-routing').build()
    const cfg = {
      R1: ['ip route 0.0.0.0 0.0.0.0 10.1.12.2'],
      R2: ['ip route 192.168.1.0 255.255.255.0 10.1.12.1',
        'ip route 192.168.3.0 255.255.255.0 10.1.23.2'],
      R3: ['ip route 0.0.0.0 0.0.0.0 10.1.23.1'],
    }
    for (const [d, cmds] of Object.entries(cfg)) {
      for (const c of ['enable', 'conf t', ...cmds, 'end']) sim.consoles[d].execute(c)
    }
    const counters = (dev, ifc) => sim.net.devices[dev].interfaces[ifc].counters
    return { sim, counters }
  }

  it('start at zero and appear in show interfaces', () => {
    const { sim } = routed()
    sim.consoles.R1.execute('enable')
    const out = sim.consoles.R1.execute('show interfaces gi0/1').join('\n')
    expect(out).toContain('0 packets input, 0 bytes, 0 no buffer')
    expect(out).toContain('0 input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored')
    expect(out).toContain('Last clearing of "show interface" counters never')
  })

  it('count 5 x 100-byte echoes each way on every hop of the path', () => {
    const { sim, counters } = routed()
    sim.consoles.R1.execute('ping 192.168.3.10')
    // Echo out and reply in on the source; the mirror image on each transit hop.
    for (const [dev, ifc] of [['R1', 'GigabitEthernet0/1'], ['R2', 'GigabitEthernet0/1'],
      ['R2', 'GigabitEthernet0/2'], ['R3', 'GigabitEthernet0/1'], ['R3', 'GigabitEthernet0/0']]) {
      const c = counters(dev, ifc)
      expect({ dev, ifc, ...c }).toMatchObject({
        inPackets: 5, inBytes: 500, outPackets: 5, outBytes: 500,
      })
    }
  })

  it('count host pings at 4 x 74 bytes', () => {
    const { sim, counters } = routed()
    sim.consoles.PC1.execute('ping 192.168.3.10')
    expect(counters('R2', 'GigabitEthernet0/1')).toMatchObject({
      inPackets: 4, inBytes: 296, outPackets: 4, outBytes: 296,
    })
  })

  it('do not move for a ping that fails', () => {
    const { sim, counters } = routed()
    sim.consoles.R1.execute('ping 10.9.9.9')
    expect(counters('R1', 'GigabitEthernet0/1')).toMatchObject({
      inPackets: 0, outPackets: 0,
    })
  })

  it('error counters are seedable so a scenario can stage a faulty link', () => {
    const { sim } = routed()
    Object.assign(sim.net.devices.R1.interfaces['GigabitEthernet0/1'].counters,
      { crc: 421, inErrors: 421, collisions: 17, lateCollision: 3 })
    sim.consoles.R1.execute('enable')
    const out = sim.consoles.R1.execute('show interfaces gi0/1').join('\n')
    expect(out).toContain('421 input errors, 421 CRC')
    expect(out).toContain('0 output errors, 17 collisions')
    expect(out).toContain('0 babbles, 3 late collision')
  })
})

describe('interface state changes log like IOS', () => {
  const iface = () => {
    const sim = getScenario('ipv4-addressing').build()
    const cli = sim.consoles.R1
    for (const c of ['enable', 'conf t', 'interface gi0/0',
      'ip address 192.168.50.1 255.255.255.192']) cli.execute(c)
    return cli
  }

  it('reports link and line protocol coming up', () => {
    const out = iface().execute('no shutdown')
    expect(out[0]).toMatch(/%LINK-3-UPDOWN: Interface GigabitEthernet0\/0, changed state to up$/)
    expect(out[1]).toMatch(/%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0\/0, changed state to up$/)
  })

  it('uses LINK-5-CHANGED for an administrative shutdown', () => {
    const cli = iface()
    cli.execute('no shutdown')
    const out = cli.execute('shutdown')
    expect(out[0]).toMatch(/%LINK-5-CHANGED:.*administratively down$/)
    expect(out[1]).toMatch(/%LINEPROTO-5-UPDOWN:.*changed state to down$/)
  })

  it('says nothing when the state does not actually change', () => {
    const cli = iface()
    cli.execute('no shutdown')
    expect(cli.execute('no shutdown')).toEqual([])
  })

  it('timestamps are deterministic and increase', () => {
    const cli = iface()
    const [first] = cli.execute('no shutdown')
    expect(first).toMatch(/^\*Mar {2}1 00:00:01\.000: /)
    const [next] = cli.execute('shutdown')
    expect(next).toMatch(/^\*Mar {2}1 00:00:03\.000: /)
  })
})

describe('negation works in every sub-config mode', () => {
  it('line mode undoes login, password and transport', () => {
    const sim = getScenario('ssh').build()
    const cli = sim.consoles.R1
    for (const c of ['enable', 'conf t', 'line vty 0 4',
      'password cisco', 'login local', 'transport input ssh']) cli.execute(c)
    const vty = () => sim.net.devices.R1.lines.vty
    expect(vty().login).toBe('local')
    for (const c of ['no login', 'no password', 'no transport input']) {
      expect(cli.execute(c)).toEqual([])
    }
    expect(vty().login).toBe(null)
    expect(vty().password).toBe(null)
    expect(vty().transportInput).toEqual([])
  })

  it('vlan mode resets the name to the IOS default', () => {
    const sim = getScenario('vlan-basics').build()
    const cli = sim.consoles.SW1
    for (const c of ['enable', 'conf t', 'vlan 10', 'name SALES']) cli.execute(c)
    expect(sim.net.devices.SW1.vlans[10].name).toBe('SALES')
    cli.execute('no name')
    expect(sim.net.devices.SW1.vlans[10].name).toBe('VLAN0010')
  })

  it('dhcp pool mode clears pool settings', () => {
    const sim = getScenario('dhcp').build()
    const cli = sim.consoles.R2
    for (const c of ['enable', 'conf t', 'ip dhcp pool LAN1',
      'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1']) cli.execute(c)
    cli.execute('no default-router')
    expect(Object.values(sim.net.devices.R2.dhcpPools)[0].defaultRouter).toBe(null)
  })
})

describe('show interfaces', () => {
  const router = () => {
    const sim = getScenario('ipv4-addressing').build()
    const cli = sim.consoles.R1
    for (const c of ['enable', 'conf t', 'interface gi0/0',
      'ip address 192.168.50.1 255.255.255.192', 'no shutdown', 'end']) cli.execute(c)
    return cli
  }

  it('reports one interface in full', () => {
    const out = router().execute('show interfaces gi0/0').join('\n')
    expect(out).toContain('GigabitEthernet0/0 is up, line protocol is up')
    expect(out).toContain('Internet address is 192.168.50.1/26')
  })

  it('lists every interface when given no name', () => {
    const out = router().execute('show interfaces').join('\n')
    expect(out).toContain('GigabitEthernet0/0 is')
    expect(out).toContain('GigabitEthernet0/1 is')
  })

  it('rejects an interface that does not exist with a caret error', () => {
    const cli = router()
    const out = cli.execute('show interfaces bogus9/9')
    expect(out[1]).toBe("% Invalid input detected at '^' marker.")
    expect(out[0].indexOf('^')).toBe(cli.prompt().length + 'show interfaces '.length)
  })

  it('still routes "show interfaces trunk" to the trunk table', () => {
    const sim = getScenario('vlan-basics').build()
    const cli = sim.consoles.SW1
    for (const c of ['enable', 'conf t', 'interface gi0/24',
      'switchport mode trunk', 'end']) cli.execute(c)
    expect(cli.execute('show interfaces trunk')[0]).toContain('Port')
  })
})

describe('incomplete vs invalid', () => {
  const exec = (cmds) => {
    const cli = getScenario('ospf').build().consoles.R1
    let out = []
    for (const c of cmds) out = cli.execute(c)
    return out
  }

  // Bare `show` used to print the version banner: with an empty subcommand every
  // ''.startsWith(sub) test is vacuously true, and 'version' was the first to hit.
  it('bare "show" is incomplete, not the version banner', () => {
    expect(exec(['enable', 'show'])).toEqual(['% Incomplete command.'])
  })

  it('"show ip" with no subcommand is incomplete', () => {
    expect(exec(['enable', 'show ip'])).toEqual(['% Incomplete command.'])
  })

  it.each(['show version', 'show ver', 'show ip route', 'show ip int brief'])(
    '%s still resolves', (cmd) => {
      const out = exec(['enable', cmd])
      expect(out[0]).not.toMatch(/Incomplete|Invalid/)
    })
})

describe('"no" resolves abbreviations', () => {
  it.each(['no shutdown', 'no shut', 'no sh'])('%s brings the interface up', (cmd) => {
    const { cli, ifc } = router()
    expect(ifc().shutdown).toBe(true)
    expect(cli.execute(cmd).join('\n')).toMatch(/%LINK-3-UPDOWN.*changed state to up/)
    expect(ifc().shutdown).toBe(false)
  })

  it('"no ip add" clears the address', () => {
    const { cli, ifc } = router()
    cli.execute('ip address 192.168.50.1 255.255.255.192')
    expect(ifc().ip).toBe('192.168.50.1')
    cli.execute('no ip add')
    expect(ifc().ip).toBe(null)
  })

  it('an ambiguous negation is reported, not guessed', () => {
    const { cli } = router()
    expect(cli.execute('no s').join('\n')).toMatch(/Ambiguous/)
  })

  it('an unknown negation errors rather than reporting success', () => {
    const { cli } = router()
    expect(cli.execute('no bogus').join('\n')).toMatch(INVALID)
  })

  it('bare "no" is incomplete', () => {
    const { cli } = router()
    expect(cli.execute('no').join('\n')).toMatch(/Incomplete/)
  })
})

describe('native VLAN mismatch is reported like IOS', () => {
  const trunkPair = () => {
    const sim = getScenario('vlan-basics').build()
    for (const sw of ['SW1', 'SW2']) {
      for (const c of ['enable', 'conf t', 'vlan 99', 'exit', 'interface gi0/24',
        'switchport mode trunk']) sim.consoles[sw].execute(c)
    }
    return sim
  }
  const MISMATCH = /%CDP-4-NATIVE_VLAN_MISMATCH/

  it('warns when one end moves its native VLAN and the other has not', () => {
    const sim = trunkPair()
    const out = sim.consoles.SW1.execute('switchport trunk native vlan 99')
    expect(out.join('\n')).toMatch(MISMATCH)
    expect(out[0]).toContain('GigabitEthernet0/24 (99)')
    expect(out[0]).toContain('SW2 GigabitEthernet0/24 (1)')
  })

  it('stays quiet once both ends agree', () => {
    const sim = trunkPair()
    sim.consoles.SW1.execute('switchport trunk native vlan 99')
    expect(sim.consoles.SW2.execute('switchport trunk native vlan 99')).toEqual([])
  })

  it('warns from whichever console created the disagreement', () => {
    const sim = trunkPair()
    sim.consoles.SW1.execute('switchport trunk native vlan 99')
    const out = sim.consoles.SW2.execute('switchport trunk native vlan 88')
    expect(out[0]).toContain('GigabitEthernet0/24 (88)')
    expect(out[0]).toContain('SW1 GigabitEthernet0/24 (99)')
  })

  it('does not warn on an access port', () => {
    const sim = getScenario('vlan-basics').build()
    for (const c of ['enable', 'conf t', 'interface gi0/1',
      'switchport mode access']) sim.consoles.SW1.execute(c)
    expect(sim.consoles.SW1.execute('switchport mode access')).toEqual([])
  })

  it('show cdp neighbors detail reports the far end native VLAN', () => {
    const sim = trunkPair()
    sim.consoles.SW1.execute('switchport trunk native vlan 99')
    sim.consoles.SW1.execute('end')
    expect(sim.consoles.SW1.execute('show cdp neighbors detail').join('\n'))
      .toContain('Native VLAN: 1')
  })
})

describe('show etherchannel summary matches IOS layout', () => {
  const lab = (mode, bothEnds = true) => {
    const sim = getScenario('etherchannel').build()
    const switches = bothEnds ? ['SW1', 'SW2'] : ['SW1']
    for (const sw of switches) {
      for (const c of ['enable', 'conf t', 'interface gi0/1', `channel-group 1 mode ${mode}`,
        'exit', 'interface gi0/2', `channel-group 1 mode ${mode}`, 'end']) sim.consoles[sw].execute(c)
    }
    return sim.consoles.SW1.execute('show etherchannel summary')
  }

  it('flags the port-channel itself, not just the ports', () => {
    // The flag was computed and thrown away: the column printed a bare "Po1"
    // while the lablet told the learner to look for "Po1(U)".
    const row = lab('active').at(-1)
    expect(row).toMatch(/Po1\(SU\)/)
  })

  it('shows SD and (D) when the far end is not configured', () => {
    const row = lab('active', false).at(-1)
    expect(row).toMatch(/Po1\(SD\)/)
    expect(row).toMatch(/Gi0\/1\(D\)/)
  })

  it('carries the full IOS flag legend', () => {
    const out = lab('active').join('\n')
    for (const line of ['D - down', 'P - in port-channel', 'H - Hot-standby (LACP only)',
      'R - Layer3', 'S - Layer2', 'u - unsuitable for bundling', 'U - in use', 'd - default port']) {
      expect(out).toContain(line)
    }
  })

  it('aligns the port column under its header', () => {
    const out = lab('active')
    const header = out.find(l => l.startsWith('Group'))
    const row = out.at(-1)
    expect(row.indexOf('Po1')).toBe(header.indexOf('Port-channel'))
    expect(row.indexOf('LACP')).toBe(header.indexOf('Protocol'))
    expect(row.indexOf('Gi0/1')).toBe(header.indexOf('Ports'))
  })
})

describe('EXEC mode navigation matches IOS', () => {
  const r1 = () => getScenario('ipv4-addressing').build().consoles.R1

  it('disable steps down from privileged to user EXEC, silently', () => {
    const cli = r1()
    cli.execute('enable')
    expect(cli.prompt()).toBe('R1#')
    expect(cli.execute('disable')).toEqual([])
    expect(cli.prompt()).toBe('R1>')
  })

  it('exit ends the session rather than de-privileging', () => {
    const cli = r1()
    cli.execute('enable')
    const out = cli.execute('exit').join('\n')
    expect(out).toContain('R1 con0 is now available')
    expect(out).toContain('Press RETURN to get started.')
    expect(cli.prompt()).toBe('R1>')
  })

  // `end` is a configuration-mode command. At an EXEC prompt IOS rejects it.
  it.each([[[], 'R1>'], [['enable'], 'R1#']])('end is invalid at %s', (setup, prompt) => {
    const cli = r1()
    for (const c of setup) cli.execute(c)
    expect(cli.prompt()).toBe(prompt)
    expect(cli.execute('end').join('\n')).toMatch(/% Invalid input detected/)
    expect(cli.prompt()).toBe(prompt)
  })

  it('end returns to privileged EXEC from any config mode', () => {
    for (const setup of [['enable', 'conf t'], ['enable', 'conf t', 'interface gi0/0'],
      ['enable', 'conf t', 'line vty 0 4'], ['enable', 'conf t', 'router ospf 1']]) {
      const cli = r1()
      for (const c of setup) cli.execute(c)
      expect(cli.execute('end')).toEqual([])
      expect(cli.prompt()).toBe('R1#')
    }
  })

  it('exit steps up one level from config modes', () => {
    const cli = r1()
    for (const c of ['enable', 'conf t', 'interface gi0/0']) cli.execute(c)
    cli.execute('exit')
    expect(cli.prompt()).toBe('R1(config)#')
    cli.execute('exit')
    expect(cli.prompt()).toBe('R1#')
  })
})

describe('passwords in running-config (blueprint 5.3)', () => {
  const hardened = (extra = []) => {
    const sim = getScenario('device-hardening').build()
    const cli = sim.consoles.R1
    for (const c of ['enable', 'conf t', 'enable secret cisco123',
      'enable password otherpass', 'line console 0', 'password conpass', 'login',
      'exit', ...extra, 'end']) cli.execute(c)
    return cli.execute('show running-config').join('\n')
  }

  it('never shows the enable secret in the clear', () => {
    const cfg = hardened()
    expect(cfg).not.toContain('enable secret cisco123')
    expect(cfg).toMatch(/enable secret 5 \$1\$/)
  })

  it('shows passwords in the clear until service password-encryption', () => {
    expect(hardened()).toContain('enable password otherpass')
    expect(hardened()).toContain(' password conpass')
  })

  it('converts passwords to type 7 once encryption is on', () => {
    const cfg = hardened(['service password-encryption'])
    expect(cfg).not.toContain('otherpass')
    expect(cfg).not.toContain('conpass')
    expect(cfg).toMatch(/enable password 7 [0-9A-F]+/)
    expect(cfg).toMatch(/ password 7 [0-9A-F]+/)
  })

  it('leaves the secret hashed, not re-encrypted, when type 7 is enabled', () => {
    expect(hardened(['service password-encryption'])).toMatch(/enable secret 5 \$1\$/)
  })

  it('hashes a local user secret too', () => {
    const cli = getScenario('ssh').build().consoles.R1
    for (const c of ['enable', 'conf t', 'username admin secret cisco123', 'end']) cli.execute(c)
    const cfg = cli.execute('show running-config').join('\n')
    expect(cfg).not.toContain('secret cisco123')
    expect(cfg).toMatch(/username admin secret 5 \$1\$/)
  })

  it('refuses an enable password identical to the enable secret', () => {
    const sim = getScenario('device-hardening').build()
    const cli = sim.consoles.R1
    for (const c of ['enable', 'conf t', 'enable secret cisco123']) cli.execute(c)
    const out = cli.execute('enable password cisco123').join('\n')
    expect(out).toContain('same as your enable secret')
    expect(sim.net.devices.R1.enablePassword).toBe(null)
  })

  it('accepts an enable password that differs from the secret', () => {
    const sim = getScenario('device-hardening').build()
    const cli = sim.consoles.R1
    for (const c of ['enable', 'conf t', 'enable secret cisco123']) cli.execute(c)
    expect(cli.execute('enable password otherpass')).toEqual([])
    expect(sim.net.devices.R1.enablePassword).toBe('otherpass')
  })

  it('type 7 is reversible, which is the whole lesson', async () => {
    const { type7 } = await import('../src/engine/show.js')
    const KEY = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87'
    const decode = (enc) => {
      const salt = parseInt(enc.slice(0, 2), 10)
      let out = ''
      for (let i = 0; i * 2 + 2 < enc.length; i++) {
        const byte = parseInt(enc.substr(2 + i * 2, 2), 16)
        out += String.fromCharCode(byte ^ KEY.charCodeAt((salt + i) % KEY.length))
      }
      return out
    }
    expect(decode(type7('conpass'))).toBe('conpass')
  })
})

describe('enable challenges for a password when one is configured', () => {
  const r1 = (setup = []) => {
    const sim = getScenario('device-hardening').build()
    const cli = sim.consoles.R1
    for (const c of setup) cli.execute(c)
    return { sim, cli }
  }
  const withSecret = () => r1(['enable', 'conf t', 'enable secret cisco123', 'end', 'disable'])

  it('goes straight to privileged EXEC when nothing is configured', () => {
    const { cli } = r1()
    expect(cli.execute('enable')).toEqual([])
    expect(cli.prompt()).toBe('R1#')
    expect(cli.masked).toBe(false)
  })

  it('prompts once a secret exists, and masks the input', () => {
    const { cli } = withSecret()
    expect(cli.execute('enable')).toEqual([])
    expect(cli.prompt()).toBe('Password: ')
    expect(cli.masked).toBe(true)
  })

  it('accepts the secret and clears the prompt', () => {
    const { cli } = withSecret()
    cli.execute('enable')
    expect(cli.execute('cisco123')).toEqual([])
    expect(cli.prompt()).toBe('R1#')
    expect(cli.masked).toBe(false)
  })

  it.each([['letmein'], ['']])('denies %s and returns to user EXEC', (attempt) => {
    const { cli } = withSecret()
    cli.execute('enable')
    expect(cli.execute(attempt)).toEqual(['% Access denied'])
    expect(cli.prompt()).toBe('R1>')
    expect(cli.masked).toBe(false)
  })

  it('lets you retry without limit', () => {
    const { cli } = withSecret()
    for (let i = 0; i < 3; i++) {
      cli.execute('enable')
      expect(cli.execute('wrong')).toEqual(['% Access denied'])
    }
    cli.execute('enable')
    cli.execute('cisco123')
    expect(cli.prompt()).toBe('R1#')
  })

  it('treats the password line verbatim, not as a command', () => {
    const { cli, sim } = withSecret()
    cli.execute('enable')
    // A password that looks like a command must not be executed as one.
    expect(cli.execute('conf t')).toEqual(['% Access denied'])
    expect(cli.prompt()).toBe('R1>')
    expect(sim.net.devices.R1.hostname).toBe('R1')
  })

  it('falls back to the enable password when no secret is set', () => {
    const { cli } = r1(['enable', 'conf t', 'enable password letmein', 'end', 'disable'])
    cli.execute('enable')
    expect(cli.execute('letmein')).toEqual([])
    expect(cli.prompt()).toBe('R1#')
  })

  it('ignores the weaker password when a secret exists', () => {
    const { cli } = r1(['enable', 'conf t', 'enable password letmein',
      'enable secret cisco123', 'end', 'disable'])
    cli.execute('enable')
    expect(cli.execute('letmein')).toEqual(['% Access denied'])
    cli.execute('enable')
    expect(cli.execute('cisco123')).toEqual([])
    expect(cli.prompt()).toBe('R1#')
  })
})

describe('show ip ospf neighbor reports router IDs, not hostnames', () => {
  const converged = () => {
    const sim = getScenario('ospf').build()
    const cfg = {
      R1: ['router ospf 1', 'router-id 1.1.1.1', 'network 10.1.12.0 0.0.0.3 area 0',
        'network 192.168.1.0 0.0.0.255 area 0'],
      R2: ['router ospf 1', 'network 10.1.12.0 0.0.0.3 area 0', 'network 10.1.23.0 0.0.0.3 area 0'],
      R3: ['router ospf 1', 'network 10.1.23.0 0.0.0.3 area 0', 'network 192.168.3.0 0.0.0.255 area 0'],
    }
    for (const [d, cmds] of Object.entries(cfg)) {
      for (const c of ['enable', 'conf t', ...cmds, 'end']) sim.consoles[d].execute(c)
    }
    return sim
  }

  it('never prints a hostname in the Neighbor ID column', () => {
    const out = converged().consoles.R2.execute('show ip ospf neighbor').join('\n')
    expect(out).not.toMatch(/^R[13]\s/m)
    for (const line of out.split('\n').slice(1)) {
      expect(line).toMatch(/^\d{1,3}(\.\d{1,3}){3}\s/)
    }
  })

  it('shows a pinned router-id verbatim', () => {
    const out = converged().consoles.R2.execute('show ip ospf neighbor').join('\n')
    expect(out).toMatch(/^1\.1\.1\.1\s/m)
  })

  it('derives the ID from the highest interface IP when not pinned', () => {
    const out = converged().consoles.R2.execute('show ip ospf neighbor').join('\n')
    // R3 owns 10.1.23.2 and 192.168.3.1; the higher address wins.
    expect(out).toMatch(/^192\.168\.3\.1\s/m)
  })

  it('prefers a loopback over a higher physical address', () => {
    const sim = converged()
    for (const c of ['conf t', 'interface loopback 0', 'ip address 3.3.3.3 255.255.255.255',
      'end']) sim.consoles.R3.execute(c)
    expect(sim.consoles.R2.execute('show ip ospf neighbor').join('\n')).toMatch(/^3\.3\.3\.3\s/m)
  })

  it('names the local interface the adjacency formed over', () => {
    const out = converged().consoles.R2.execute('show ip ospf neighbor').join('\n')
    expect(out).toContain('GigabitEthernet0/1')
    expect(out).toContain('GigabitEthernet0/2')
  })

  it('show ip ospf reports the effective ID, not "(unset)"', () => {
    const sim = converged()
    expect(sim.consoles.R1.execute('show ip ospf').join('\n')).toContain('with ID 1.1.1.1')
    expect(sim.consoles.R2.execute('show ip ospf').join('\n')).not.toContain('unset')
  })
})
