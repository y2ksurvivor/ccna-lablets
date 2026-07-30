// Mode-aware IOS-style CLI engine.
//
// The CLI holds a reference to a device and a mode stack. execute(line) parses
// the line against the command tree for the current mode, mutates device state,
// and returns output lines. It also powers `?` help and Tab completion.
//
// Modes:
//   user      >           user EXEC
//   enable    #           privileged EXEC
//   config    (config)#   global config
//   iface     (config-if)#         interface sub-config
//   vlan      (config-vlan)#       vlan sub-config
//   line      (config-line)#       line sub-config
//   router    (config-router)#     routing protocol sub-config

import { getInterface, canonicalIface, shortIface } from './device.js'
import { renderRunningConfig, renderIpIntBrief, renderVlanBrief } from './show.js'

export class CLI {
  constructor(device) {
    this.dev = device
    this.mode = 'user'
    this.ctx = {} // sub-config context (e.g. current interface)
  }

  prompt() {
    const h = this.dev.hostname
    switch (this.mode) {
      case 'user': return `${h}>`
      case 'enable': return `${h}#`
      case 'config': return `${h}(config)#`
      case 'iface': return `${h}(config-if)#`
      case 'vlan': return `${h}(config-vlan)#`
      case 'line': return `${h}(config-line)#`
      case 'router': return `${h}(config-router)#`
      default: return `${h}>`
    }
  }

  // Execute one command line. Returns array of output strings.
  execute(line) {
    const raw = line.trim()
    if (raw === '') return []
    if (raw === '?') return formatHelp(this.helpTokens([]))

    // trailing ? -> context help
    if (raw.endsWith('?')) {
      const partial = raw.slice(0, -1)
      const toks = tokenize(partial)
      const endsSpace = /\s$/.test(partial) || partial === ''
      const prefix = endsSpace ? toks : toks.slice(0, -1)
      const partialWord = endsSpace ? '' : (toks[toks.length - 1] || '')

      // If a command word is already typed, it must be valid before we can
      // offer help for its arguments — otherwise IOS flags the bad token.
      if (prefix.length > 0) {
        const table = COMMANDS[this.mode] || {}
        const m = matchCommand(table, prefix[0])
        if (m.error) return this.renderMatchError(m, raw)
      }

      const entries = this.helpTokens(prefix, partialWord)
      // Word help with no matches (e.g. "xyz?") is an invalid token in IOS.
      if (entries.length === 0 && partialWord) return this.caretError(raw, partialWord)
      return formatHelp(entries)
    }

    const tokens = tokenize(raw)
    // `do <cmd>` runs an EXEC command from a config mode
    if (this.mode.startsWith('config') || ['iface', 'vlan', 'line', 'router'].includes(this.mode)) {
      if (tokens[0] === 'do') {
        const saved = this.mode
        this.mode = 'enable'
        const out = this.dispatch(tokens.slice(1), tokens.slice(1).join(' '))
        this.mode = saved
        return out
      }
    }
    return this.dispatch(tokens, raw)
  }

  dispatch(tokens, raw) {
    if (tokens.length === 0) return []
    const table = COMMANDS[this.mode] || {}
    const match = matchCommand(table, tokens[0])
    if (match.error) return this.renderMatchError(match, raw ?? tokens.join(' '))
    const cmd = table[match.name]
    return cmd.run(this, tokens.slice(1), tokens)
  }

  // Render a typed match error the way IOS does. For an invalid token we print
  // a caret line under the offending token, aligned to the on-screen prompt.
  renderMatchError(match, raw) {
    if (match.error === 'ambiguous') {
      return [`% Ambiguous command:  "${match.token}"`]
    }
    return this.caretError(raw, match.token)
  }

  caretError(raw, token) {
    const idx = token != null ? raw.indexOf(token) : Math.max(0, raw.length - 1)
    const col = this.prompt().length + (idx < 0 ? 0 : idx)
    return [`${' '.repeat(col)}^`, `% Invalid input detected at '^' marker.`]
  }

  // Help entries available at current position.
  //   prefixTokens = fully-typed tokens before the partial word
  //   partial      = the word currently being typed (may be '')
  // With no prefix, list matching commands for the mode. With a command already
  // typed, delegate to that command's argHelp(cli, restArgs) for the next token.
  helpTokens(prefixTokens, partial = '') {
    const table = COMMANDS[this.mode] || {}

    if (prefixTokens.length === 0) {
      return Object.entries(table)
        .filter(([name]) => name !== '?' && name.startsWith(partial))
        .map(([name, c]) => ({ name, help: c.help || '' }))
        .sort((a, b) => a.name.localeCompare(b.name))
    }

    const match = matchCommand(table, prefixTokens[0])
    if (match.error) return [] // execute() validates and renders errors before calling us
    const cmd = table[match.name]
    const restArgs = prefixTokens.slice(1)

    let entries
    if (cmd.argHelp) {
      entries = cmd.argHelp(this, restArgs)
    } else {
      entries = [{ name: '<cr>', help: '' }]
    }
    return entries
      .filter(e => e.name === '<cr>' ? partial === '' : e.name.startsWith(partial))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  // Tab / space completion for a partial token.
  complete(line) {
    const tokens = tokenize(line)
    const endsSpace = /\s$/.test(line)
    const table = COMMANDS[this.mode] || {}
    if (tokens.length === 0 || (tokens.length === 1 && !endsSpace)) {
      const partial = tokens[0] || ''
      const hits = Object.keys(table).filter(n => n.startsWith(partial))
      if (hits.length === 1) return hits[0] + ' '
    }
    return null
  }
}

// --- command tables ----------------------------------------------------------
// Each entry: { help, run(cli, args, allTokens) -> string[] }

function needEnable(cli) {
  return cli.mode === 'enable'
}

const COMMANDS = {
  user: {
    enable: {
      help: 'Turn on privileged commands',
      run: (cli) => { cli.mode = 'enable'; return [] },
    },
    ping: { help: 'Send echo messages', argHelp: pingArgHelp, run: (cli, a) => pingCmd(cli, a) },
    show: { help: 'Show running system information', argHelp: showArgHelp, run: (cli, a) => showCmd(cli, a) },
    exit: { help: 'Exit from the EXEC', run: () => [] },
    '?': { help: 'Help', run: () => [] },
  },

  enable: {
    disable: { help: 'Turn off privileged commands', run: (cli) => { cli.mode = 'user'; return [] } },
    configure: {
      help: 'Enter configuration mode',
      argHelp: () => [{ name: 'terminal', help: 'Configure from the terminal' }],
      run: (cli, a) => {
        if (a[0] && !'terminal'.startsWith(a[0])) return ['% Invalid input']
        cli.mode = 'config'
        return ['Enter configuration commands, one per line.  End with CNTL/Z.']
      },
    },
    show: { help: 'Show running system information', argHelp: showArgHelp, run: (cli, a) => showCmd(cli, a) },
    ping: { help: 'Send echo messages', argHelp: pingArgHelp, run: (cli, a) => pingCmd(cli, a) },
    write: { help: 'Save configuration', run: (cli) => { cli.dev.startupConfig = true; return ['Building configuration...', '[OK]'] } },
    copy: {
      help: 'Copy running-config',
      run: (cli, a) => { cli.dev.startupConfig = true; return ['Destination filename [startup-config]?', 'Building configuration...', '[OK]'] },
    },
    exit: { help: 'Exit from the EXEC', run: (cli) => { cli.mode = 'user'; return [] } },
  },

  config: {
    hostname: {
      help: 'Set system network name',
      argHelp: () => [{ name: 'WORD', help: 'This system\'s network name' }],
      run: (cli, a) => {
        if (!a[0]) return ['% Incomplete command.']
        cli.dev.hostname = a[0]
        return []
      },
    },
    interface: {
      help: 'Select an interface to configure',
      argHelp: interfaceArgHelp,
      run: (cli, a) => {
        const canon = canonicalIface(a.join(''))
        if (!canon) return ['% Invalid interface']
        cli.ctx.iface = getInterface(cli.dev, canon)
        cli.mode = 'iface'
        return []
      },
    },
    vlan: {
      help: 'Configure VLAN',
      argHelp: () => [{ name: '<1-4094>', help: 'ISL VLAN IDs 1-4094' }],
      run: (cli, a) => {
        if (cli.dev.kind !== 'switch') return ['% Invalid input detected']
        const id = parseInt(a[0], 10)
        if (!id || id < 1 || id > 4094) return ['% Invalid VLAN']
        if (!cli.dev.vlans[id]) cli.dev.vlans[id] = { id, name: `VLAN${String(id).padStart(4, '0')}` }
        cli.ctx.vlan = cli.dev.vlans[id]
        cli.mode = 'vlan'
        return []
      },
    },
    'enable': {
      help: 'Modify enable password parameters',
      argHelp: (cli, a) => a.length === 0
        ? [{ name: 'secret', help: 'Assign the privileged level secret' }]
        : [{ name: 'WORD', help: 'The enable secret' }],
      run: (cli, a) => {
        if (a[0] === 'secret') { cli.dev.enableSecret = a.slice(1).join(' '); return [] }
        return ['% Incomplete command.']
      },
    },
    'ip': {
      help: 'Global IP configuration',
      argHelp: (cli, a) => {
        if (a.length === 0) return [{ name: 'route', help: 'Establish static routes' }]
        if (a[0] === 'route') {
          if (a.length === 1) return [{ name: 'A.B.C.D', help: 'Destination prefix' }]
          if (a.length === 2) return [{ name: 'A.B.C.D', help: 'Destination prefix mask' }]
          if (a.length === 3) return [{ name: 'A.B.C.D', help: 'Forwarding router\'s address' }]
        }
        return [{ name: '<cr>', help: '' }]
      },
      run: (cli, a) => ipConfigCmd(cli, a),
    },
    'no': { help: 'Negate a command', run: (cli, a) => negate(cli, a) },
    exit: { help: 'Exit config mode', run: (cli) => { cli.mode = 'enable'; return [] } },
    end: { help: 'Return to privileged EXEC', run: (cli) => { cli.mode = 'enable'; return [] } },
  },

  iface: {
    'ip': {
      help: 'Interface IP config',
      argHelp: (cli, a) => {
        if (a.length === 0) return [{ name: 'address', help: 'Set the IP address of an interface' }]
        if (a[0] === 'address') {
          if (a.length === 1) return [{ name: 'A.B.C.D', help: 'IP address' }]
          if (a.length === 2) return [{ name: 'A.B.C.D', help: 'IP subnet mask' }]
        }
        return [{ name: '<cr>', help: '' }]
      },
      run: (cli, a) => {
        if (a[0] === 'address') {
          const [ip, mask] = [a[1], a[2]]
          if (!ip || !mask) return ['% Incomplete command.']
          cli.ctx.iface.ip = ip
          cli.ctx.iface.mask = mask
          return []
        }
        return ['% Invalid input detected']
      },
    },
    'description': { help: 'Interface description', argHelp: () => [{ name: 'LINE', help: 'Up to 240 characters describing this interface' }], run: (cli, a) => { cli.ctx.iface.description = a.join(' '); return [] } },
    'shutdown': { help: 'Shut down interface', run: (cli) => { cli.ctx.iface.shutdown = true; cli.ctx.iface.lineProtocol = false; return [] } },
    'switchport': { help: 'Set switching mode', argHelp: switchportArgHelp, run: (cli, a) => switchportCmd(cli, a) },
    'no': { help: 'Negate a command', run: (cli, a) => negate(cli, a) },
    exit: { help: 'Exit interface config', run: (cli) => { cli.mode = 'config'; return [] } },
    end: { help: 'Return to privileged EXEC', run: (cli) => { cli.mode = 'enable'; return [] } },
  },

  vlan: {
    name: { help: 'Set VLAN name', run: (cli, a) => { cli.ctx.vlan.name = a[0] || cli.ctx.vlan.name; return [] } },
    exit: { help: 'Exit VLAN config', run: (cli) => { cli.mode = 'config'; return [] } },
    end: { help: 'Return to privileged EXEC', run: (cli) => { cli.mode = 'enable'; return [] } },
  },

  line: {
    exit: { help: 'Exit line config', run: (cli) => { cli.mode = 'config'; return [] } },
    end: { help: 'Return to privileged EXEC', run: (cli) => { cli.mode = 'enable'; return [] } },
  },

  router: {
    exit: { help: 'Exit router config', run: (cli) => { cli.mode = 'config'; return [] } },
    end: { help: 'Return to privileged EXEC', run: (cli) => { cli.mode = 'enable'; return [] } },
  },
}

// --- argument help providers -------------------------------------------------
// Each returns the list of valid NEXT tokens given the args already typed.

function showArgHelp(cli, a) {
  if (a.length === 0) {
    const opts = [
      { name: 'running-config', help: 'Current operating configuration' },
      { name: 'ip', help: 'IP information' },
      { name: 'version', help: 'System hardware and software status' },
    ]
    if (cli.dev.kind === 'switch') opts.push({ name: 'vlan', help: 'VTP VLAN status' })
    return opts
  }
  if (a[0] === 'ip') {
    if (a.length === 1) return [
      { name: 'interface', help: 'IP interface status and configuration' },
      { name: 'route', help: 'IP routing table' },
    ]
    if (a[1] === 'interface') return [{ name: 'brief', help: 'Brief summary of IP status' }]
  }
  return [{ name: '<cr>', help: '' }]
}

function pingArgHelp() {
  return [{ name: 'A.B.C.D', help: 'Ping destination address' }]
}

function interfaceArgHelp(cli) {
  const types = [
    { name: 'GigabitEthernet', help: 'GigabitEthernet IEEE 802.3z' },
    { name: 'FastEthernet', help: 'FastEthernet IEEE 802.3' },
    { name: 'Loopback', help: 'Loopback interface' },
  ]
  if (cli.dev.kind === 'router') types.push({ name: 'Serial', help: 'Serial interface' })
  if (cli.dev.kind === 'switch') types.push({ name: 'Vlan', help: 'Catalyst VLANs' })
  return types
}

function switchportArgHelp(cli, a) {
  if (a.length === 0) return [
    { name: 'mode', help: 'Set trunking mode of the interface' },
    { name: 'access', help: 'Set access mode characteristics' },
  ]
  if (a[0] === 'mode') return [
    { name: 'access', help: 'Set trunking mode to ACCESS unconditionally' },
    { name: 'trunk', help: 'Set trunking mode to TRUNK unconditionally' },
  ]
  if (a[0] === 'access') {
    if (a.length === 1) return [{ name: 'vlan', help: 'Set VLAN when interface is in access mode' }]
    if (a[1] === 'vlan') return [{ name: '<1-4094>', help: 'VLAN ID of the VLAN when this port is in access mode' }]
  }
  return [{ name: '<cr>', help: '' }]
}

// --- command handlers --------------------------------------------------------

function negate(cli, a) {
  if (cli.mode === 'iface') {
    if (a[0] === 'shutdown') { cli.ctx.iface.shutdown = false; cli.ctx.iface.lineProtocol = !!cli.ctx.iface.ip || cli.dev.kind === 'switch'; return [] }
    if (a[0] === 'ip' && a[1] === 'address') { cli.ctx.iface.ip = null; cli.ctx.iface.mask = null; return [] }
    if (a[0] === 'description') { cli.ctx.iface.description = null; return [] }
  }
  return []
}

function switchportCmd(cli, a) {
  const ifc = cli.ctx.iface
  if (a[0] === 'mode') {
    if (a[1] === 'access') { ifc.mode = 'access'; return [] }
    if (a[1] === 'trunk') { ifc.mode = 'trunk'; return [] }
  }
  if (a[0] === 'access' && a[1] === 'vlan') {
    const id = parseInt(a[2], 10)
    if (!id) return ['% Incomplete command.']
    ifc.accessVlan = id
    return []
  }
  return ['% Invalid input detected']
}

function ipConfigCmd(cli, a) {
  // ip route <prefix> <mask> <next-hop>
  if (a[0] === 'route') {
    const [prefix, mask, nh] = [a[1], a[2], a[3]]
    if (!prefix || !mask || !nh) return ['% Incomplete command.']
    cli.dev.routes.push({ proto: 'S', prefix, mask, nextHop: nh, ad: 1, metric: 0 })
    return []
  }
  return ['% Invalid input detected']
}

function showCmd(cli, a) {
  const sub = (a[0] || '').toLowerCase()
  if ('running-config'.startsWith(sub) && sub.length >= 3) return renderRunningConfig(cli.dev)
  if (sub === 'run') return renderRunningConfig(cli.dev)
  if (sub === 'ip') {
    const s2 = (a[1] || '').toLowerCase()
    if ('interface'.startsWith(s2) && a[2] && 'brief'.startsWith((a[2] || '').toLowerCase())) return renderIpIntBrief(cli.dev)
    if ('route'.startsWith(s2)) return ['(ip routing table — coming in Phase 2)']
  }
  if (sub === 'vlan') return renderVlanBrief(cli.dev)
  if ('version'.startsWith(sub)) return ['Cisco IOS Software (CCNA Lablets simulated), Version 15.x', `${cli.dev.hostname} uptime is 0 minutes`]
  return ['% Invalid input detected']
}

function pingCmd(cli, a) {
  const target = a[0]
  if (!target) return ['% Incomplete command.']
  // Phase 1 stub — real reachability lands in Phase 2 (network engine).
  return [`Type escape sequence to abort.`, `Sending 5, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:`, `.....`, `Success rate is 0 percent (0/5)  [reachability sim arrives in Phase 2]`]
}

// --- parsing utilities -------------------------------------------------------

function tokenize(line) {
  return line.trim().split(/\s+/).filter(Boolean)
}

// Match a possibly-abbreviated token against a command table's keys.
// On failure returns a typed error the caller renders IOS-style:
//   'invalid'   -> caret line + "% Invalid input detected at '^' marker."
//   'ambiguous' -> "% Ambiguous command:  "<token>""
function matchCommand(table, token) {
  const keys = Object.keys(table).filter(k => k !== '?')
  if (keys.includes(token)) return { name: token }
  const hits = keys.filter(k => k.startsWith(token))
  if (hits.length === 1) return { name: hits[0] }
  if (hits.length === 0) return { error: 'invalid', token }
  return { error: 'ambiguous', token }
}

function pad(s, n = 18) {
  return (s + ' '.repeat(n)).slice(0, n)
}

// Format help entries for display. `<cr>` prints alone (no padding column).
function formatHelp(entries) {
  return entries.map(h =>
    h.name === '<cr>' ? '  <cr>' : `  ${pad(h.name)} ${h.help}`.trimEnd()
  )
}
