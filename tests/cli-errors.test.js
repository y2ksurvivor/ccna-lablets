// The CLI must never accept a command silently and do the wrong thing, and must
// never silently do nothing. Both mislead the learner far worse than an error
// does — a lablet task just stays red with no explanation.

import { describe, it, expect } from 'vitest'
import { getScenario } from '../src/scenarios/index.js'

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
