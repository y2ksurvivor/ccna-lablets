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

import { getInterface, canonicalIface, shortIface, observe, logIfaceState } from './device.js'
import { pingIpv6, splitPrefix, ipv6ToBig, bigToIpv6, netV6 } from './ipv6.js'
import { nativeVlanMismatch, nativeVlanMismatchLog } from './network.js'
import { pingFromDevice as devicePing } from './l3.js'
import {
  renderRunningConfig, renderIpIntBrief, renderVlanBrief,
  renderCdpNeighbors, renderLldpNeighbors, renderEtherchannelSummary, renderInterfacesTrunk,
  renderInterfaces,
  renderIpRoute, renderOspfNeighbors,
  renderIpSsh, renderNtpStatus, renderNtpAssociations, renderNatTranslations,
  renderAccessLists, renderPortSecurity, renderIpv6IntBrief, renderIpv6Route,
} from './show.js'

export class CLI {
  constructor(device, net = null) {
    this.dev = device
    this.net = net // optional Network reference, enables ping/connectivity
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
      case 'dhcp': return `${h}(dhcp-config)#`
      default: return `${h}>`
    }
  }

  // Execute one command line. Returns array of output strings.
  execute(line) {
    const raw = line.trim()
    // Remembered for the whole command so any handler, however deeply nested,
    // can point a caret at its offending token without threading the raw line
    // through every call. Must be the line as typed — including a `do` prefix —
    // because the caret is aligned against what the terminal echoed.
    this.rawLine = raw
    // Snapshot the prompt too. `do <cmd>` flips the mode to EXEC while it runs,
    // so prompt() would report the short "SW1#" while the terminal actually
    // echoed "SW1(config)#" — the caret has to line up with what was echoed.
    this.promptAtLine = this.prompt()
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
        if (m.error) return this.renderMatchError(m)
      }

      const entries = this.helpTokens(prefix, partialWord)
      // Word help with no matches (e.g. "xyz?") is an invalid token in IOS.
      if (entries.length === 0 && partialWord) return this.caretError(partialWord)
      return formatHelp(entries)
    }

    const tokens = tokenize(raw)
    // `do <cmd>` runs an EXEC command from a config mode
    if (this.mode.startsWith('config') || ['iface', 'vlan', 'line', 'router', 'dhcp'].includes(this.mode)) {
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
    if (match.error) return this.renderMatchError(match)
    const cmd = table[match.name]
    // IOS rejects trailing tokens on a command that takes no arguments — it does
    // not quietly run the command anyway. This matters most for `shutdown`:
    // typing "sh run" in interface config resolves `sh` to `shutdown`, and
    // without this check the port would be shut with no output at all.
    if (cmd.noArgs && tokens.length > 1) {
      return this.caretError(tokens[1])
    }
    // Same idea for commands that take a fixed maximum number of arguments.
    // Commands with several forms of differing length check inside their
    // handler instead (see tooMany).
    if (cmd.maxArgs != null && tokens.length - 1 > cmd.maxArgs) {
      return this.caretError(tokens[cmd.maxArgs + 1])
    }
    return cmd.run(this, tokens.slice(1), tokens)
  }

  // Render a typed match error the way IOS does. For an invalid token we print
  // a caret line under the offending token, aligned to the on-screen prompt.
  renderMatchError(match) {
    if (match.error === 'ambiguous') {
      return [`% Ambiguous command:  "${match.token}"`]
    }
    return this.caretError(match.token)
  }

  // IOS's standard parse error: a caret under the offending token, aligned to
  // the echoed line, then the message. `raw` defaults to the current command so
  // callers deep in a handler only need to name the token. Matching on a whole
  // word keeps the caret off an earlier substring — "do sho rn" must mark the
  // "rn", not the "r" inside a previous word.
  caretError(token, raw = this.rawLine ?? '') {
    let idx
    if (token == null) {
      idx = Math.max(0, raw.length - 1)
    } else {
      const esc = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const m = new RegExp(`(^|\\s)${esc}(?=\\s|$)`).exec(raw)
      idx = m ? m.index + m[1].length : raw.indexOf(token)
      if (idx < 0) idx = 0
    }
    const promptLen = (this.promptAtLine ?? this.prompt()).length
    return [`${' '.repeat(promptLen + idx)}^`, `% Invalid input detected at '^' marker.`]
  }

  // Shorthand for handlers rejecting an argument they could not interpret.
  invalid(token) {
    return this.caretError(token)
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

// `exit` at a user or privileged EXEC prompt closes the terminal session — it
// does NOT step down from # to >, which is `disable`'s job. On a console the
// session immediately becomes available again, so the learner lands back at the
// unprivileged prompt, but the banner makes clear a logout happened.
function endExecSession(cli) {
  cli.mode = 'user'
  return ['', `${cli.dev.hostname} con0 is now available`, '', 'Press RETURN to get started.']
}

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
    exit: { help: 'Exit from the EXEC', noArgs: true, run: (cli) => endExecSession(cli) },
    '?': { help: 'Help', run: () => [] },
  },

  enable: {
    disable: { help: 'Turn off privileged commands', noArgs: true, run: (cli) => { cli.mode = 'user'; return [] } },
    configure: {
      help: 'Enter configuration mode',
      argHelp: () => [{ name: 'terminal', help: 'Configure from the terminal' }],
      run: (cli, a) => {
        if (a[0] && !'terminal'.startsWith(a[0])) return cli.invalid(a[0])
        cli.mode = 'config'
        return ['Enter configuration commands, one per line.  End with CNTL/Z.']
      },
    },
    show: { help: 'Show running system information', argHelp: showArgHelp, run: (cli, a) => showCmd(cli, a) },
    ping: { help: 'Send echo messages', argHelp: pingArgHelp, run: (cli, a) => pingCmd(cli, a) },
    write: { maxArgs: 1,
      help: 'Write running configuration to memory',
      argHelp: () => [{ name: 'memory', help: 'Write to NV memory' }, { name: 'erase', help: 'Erase NV memory' }],
      run: (cli, a) => {
        if (a[0] && 'erase'.startsWith(a[0])) { cli.dev.savedConfig = null; return ['Erasing the nvram filesystem...', '[OK]'] }
        saveConfig(cli)
        return ['Building configuration...', '[OK]']
      },
    },
    // `save` is not classic IOS, but accepted here as a friendly alias for write.
    save: {
      help: 'Save running configuration (alias for write memory)',
      run: (cli) => { saveConfig(cli); return ['Building configuration...', '[OK]'] },
    },
    copy: { maxArgs: 3,
      help: 'Copy from one file to another',
      argHelp: (cli, a) => a.length === 0
        ? [{ name: 'running-config', help: 'Copy from current system configuration' }]
        : [{ name: 'startup-config', help: 'Copy to startup configuration' }],
      run: (cli, a) => {
        // copy running-config startup-config
        if ((a[0] || '').startsWith('run') && (a[1] || '').startsWith('start')) {
          saveConfig(cli)
          return ['Destination filename [startup-config]?', 'Building configuration...', '[OK]']
        }
        return ['% Incomplete command.']
      },
    },
    exit: { help: 'Exit from the EXEC', noArgs: true, run: (cli) => endExecSession(cli) },
  },

  config: {
    hostname: { maxArgs: 1,
      help: 'Set system network name',
      argHelp: () => [{ name: 'WORD', help: 'This system\'s network name' }],
      run: (cli, a) => {
        if (!a[0]) return ['% Incomplete command.']
        cli.dev.hostname = a[0]
        return []
      },
    },
    interface: { maxArgs: 1,
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
        if (cli.dev.kind !== 'switch') return cli.invalid(a[0])
        { const bad = tooMany(cli, a, 1); if (bad) return bad }
        const id = parseInt(a[0], 10)
        if (!id || id < 1 || id > 4094) return ['% Invalid VLAN']
        if (!cli.dev.vlans[id]) cli.dev.vlans[id] = { id, name: `VLAN${String(id).padStart(4, '0')}` }
        cli.ctx.vlan = cli.dev.vlans[id]
        cli.mode = 'vlan'
        return []
      },
    },
    'enable': { maxArgs: 2,
      help: 'Modify enable password parameters',
      argHelp: (cli, a) => a.length === 0
        ? [{ name: 'secret', help: 'Assign the privileged level secret' }, { name: 'password', help: 'Assign the privileged level password' }]
        : [{ name: 'WORD', help: 'The enable secret/password' }],
      run: (cli, a) => {
        const value = a.slice(1).join(' ')
        if (!value) return ['% Incomplete command.']
        if (a[0] === 'secret') { cli.dev.enableSecret = value; return [] }
        if (a[0] === 'password') {
          // IOS refuses a password identical to the secret and leaves the old
          // password in place — the two would be indistinguishable to a reader
          // of the config, defeating the point of having a hashed secret.
          if (cli.dev.enableSecret && value === cli.dev.enableSecret) {
            return ['The enable password you have chosen is the same as your enable secret.',
              'This is not recommended.  Re-enter the enable password.']
          }
          cli.dev.enablePassword = value
          return []
        }
        return ['% Incomplete command.']
      },
    },
    'service': { maxArgs: 1,
      help: 'Modify use of network based services',
      argHelp: () => [{ name: 'password-encryption', help: 'Encrypt system passwords' }],
      run: (cli, a) => {
        if ('password-encryption'.startsWith(a[0] || 'x')) { cli.dev.servicePasswordEncryption = true; return [] }
        return ['% Incomplete command.']
      },
    },
    'cdp': { maxArgs: 1,
      help: 'Global CDP configuration',
      argHelp: () => [{ name: 'run', help: 'Enable CDP' }],
      run: (cli, a) => {
        if ((a[0] || '').length && 'run'.startsWith(a[0])) { cli.dev.cdpEnabled = true; return [] }
        return ['% Incomplete command.']
      },
    },
    'lldp': { maxArgs: 1,
      help: 'Global LLDP configuration',
      argHelp: () => [{ name: 'run', help: 'Enable LLDP' }],
      run: (cli, a) => {
        if ((a[0] || '').length && 'run'.startsWith(a[0])) { cli.dev.lldpEnabled = true; return [] }
        return ['% Incomplete command.']
      },
    },
    'ipv6': {
      help: 'Global IPv6 configuration',
      argHelp: (cli, a) => a.length === 0
        ? [{ name: 'unicast-routing', help: 'Enable unicast routing' },
          { name: 'route', help: 'Configure static routes' }]
        : [{ name: 'X:X:X:X::X/<0-128>', help: 'IPv6 prefix' }],
      run: (cli, a) => {
        if ('unicast-routing'.startsWith(a[0] || 'x') && a[0]) {
          const bad = tooMany(cli, a, 1); if (bad) return bad
          cli.dev.ipv6Routing = true; return []
        }
        if (a[0] === 'route') return ipv6RouteCmd(cli, a.slice(1))
        return ['% Incomplete command.']
      },
    },
    'ip': {
      help: 'Global IP configuration',
      argHelp: (cli, a) => {
        if (a.length === 0) return [
          { name: 'route', help: 'Establish static routes' },
          { name: 'domain-name', help: 'Define the default domain name' },
          { name: 'dhcp', help: 'Configure DHCP server and relay parameters' },
          { name: 'nat', help: 'NAT configuration commands' },
        ]
        if (a[0] === 'route') {
          if (a.length === 1) return [{ name: 'A.B.C.D', help: 'Destination prefix' }]
          if (a.length === 2) return [{ name: 'A.B.C.D', help: 'Destination prefix mask' }]
          if (a.length === 3) return [{ name: 'A.B.C.D', help: 'Forwarding router\'s address' }]
        }
        if (a[0] === 'dhcp') return [{ name: 'pool', help: 'Configure a DHCP address pool' }, { name: 'excluded-address', help: 'Prevent DHCP from assigning certain addresses' }]
        if (a[0] === 'nat') {
          if (a.length === 1) return [{ name: 'inside', help: 'Inside address translation' }, { name: 'pool', help: 'Define a pool of addresses' }]
          if (a[1] === 'inside') return [{ name: 'source', help: 'Source address translation' }]
          if (a[2] === 'source') return [{ name: 'static', help: 'Static translation' }, { name: 'list', help: 'Specify access list' }]
        }
        return [{ name: '<cr>', help: '' }]
      },
      run: (cli, a) => ipConfigCmd(cli, a),
    },
    'router': { maxArgs: 2,
      help: 'Enable a routing process',
      argHelp: (cli, a) => a.length === 0
        ? [{ name: 'ospf', help: 'Open Shortest Path First (OSPF)' }]
        : [{ name: '<1-65535>', help: 'Process ID' }],
      run: (cli, a) => {
        if (!'ospf'.startsWith(a[0] || 'x')) return cli.invalid(a[0])
        const pid = parseInt(a[1], 10)
        if (!pid) return ['% Incomplete command.']
        if (!cli.dev.ospf) cli.dev.ospf = { pid, routerId: null, networks: [], passive: [] }
        cli.ctx.ospf = cli.dev.ospf
        cli.mode = 'router'
        return []
      },
    },
    'crypto': { maxArgs: 5,
      help: 'Encryption module',
      argHelp: (cli, a) => {
        if (a.length === 0) return [{ name: 'key', help: 'Long term key operations' }]
        if (a[0] === 'key') return [{ name: 'generate', help: 'Generate new keys' }]
        if (a[1] === 'generate') return [{ name: 'rsa', help: 'Generate RSA keys' }]
        return [{ name: '<cr>', help: '' }]
      },
      run: (cli, a) => cryptoCmd(cli, a),
    },
    'username': { maxArgs: 3,
      help: 'Establish user name authentication',
      argHelp: (cli, a) => a.length === 0
        ? [{ name: 'WORD', help: 'User name' }]
        : [{ name: 'secret', help: 'Specify the secret' }, { name: 'password', help: 'Specify the password' }],
      run: (cli, a) => {
        const name = a[0]
        if (!name) return ['% Incomplete command.']
        const kw = a[1]
        if (kw !== 'secret' && kw !== 'password' && !(kw && ('secret'.startsWith(kw) || 'password'.startsWith(kw)))) return ['% Incomplete command.']
        const secret = a.slice(2).join(' ')
        if (!secret) return ['% Incomplete command.']
        cli.dev.users = cli.dev.users.filter(u => u.name !== name)
        cli.dev.users.push({ name, secret })
        return []
      },
    },
    'line': {
      help: 'Configure a terminal line',
      argHelp: (cli, a) => a.length === 0
        ? [{ name: 'console', help: 'Primary terminal line' }, { name: 'vty', help: 'Virtual terminal' }]
        : [{ name: '<0-15>', help: 'First line number' }],
      run: (cli, a) => {
        const type = a[0]
        // "line vty 0 4" takes a range; "line console 0" a single number.
        const bad = tooMany(cli, a, 'vty'.startsWith(type || 'x') ? 3 : 2)
        if (bad) return bad
        if ('vty'.startsWith(type || 'x')) { cli.ctx.line = ensureLine(cli.dev, 'vty'); cli.mode = 'line' }
        else if ('console'.startsWith(type || 'x')) { cli.ctx.line = ensureLine(cli.dev, 'console'); cli.mode = 'line' }
        else return cli.invalid(type)
        return []
      },
    },
    'ntp': { maxArgs: 2,
      help: 'Configure NTP',
      argHelp: (cli, a) => a.length === 0
        ? [{ name: 'master', help: 'Act as NTP master clock' }, { name: 'server', help: 'Configure NTP server' }]
        : [{ name: 'A.B.C.D', help: 'IP address of peer' }],
      run: (cli, a) => {
        if ('master'.startsWith(a[0] || 'x')) { cli.dev.ntp.master = true; cli.dev.ntp.stratum = a[1] ? parseInt(a[1], 10) : 8; return [] }
        if ('server'.startsWith(a[0] || 'x')) { if (!a[1]) return ['% Incomplete command.']; if (!cli.dev.ntp.servers.includes(a[1])) cli.dev.ntp.servers.push(a[1]); return [] }
        return ['% Incomplete command.']
      },
    },
    'access-list': {
      help: 'Add an access list entry',
      run: (cli, a) => aclCmd(cli, a),
    },
    'no': { help: 'Negate a command', run: (cli, a) => negate(cli, a) },
    exit: { help: 'Exit config mode', noArgs: true, run: (cli) => { cli.mode = 'enable'; return [] } },
    end: { help: 'Return to privileged EXEC', noArgs: true, run: (cli) => { cli.mode = 'enable'; return [] } },
  },

  iface: {
    'ip': {
      help: 'Interface IP config',
      argHelp: (cli, a) => {
        if (a.length === 0) return [
          { name: 'address', help: 'Set the IP address of an interface' },
          { name: 'access-group', help: 'Specify access control for packets' },
          { name: 'nat', help: 'NAT interface commands' },
          { name: 'helper-address', help: 'Specify a destination address for UDP broadcasts (DHCP relay)' },
        ]
        if (a[0] === 'access-group') {
          if (a.length === 1) return [{ name: '<1-199>', help: 'Access list number' }]
          return [{ name: 'in', help: 'Inbound packets' }, { name: 'out', help: 'Outbound packets' }]
        }
        if (a[0] === 'address') {
          if (a.length === 1) return [{ name: 'A.B.C.D', help: 'IP address' }, { name: 'dhcp', help: 'IP Address negotiated via DHCP' }]
          if (a.length === 2) return [{ name: 'A.B.C.D', help: 'IP subnet mask' }]
        }
        if (a[0] === 'nat') return [{ name: 'inside', help: 'Inside interface for NAT' }, { name: 'outside', help: 'Outside interface for NAT' }]
        if (a[0] === 'helper-address') return [{ name: 'A.B.C.D', help: 'IP destination address' }]
        return [{ name: '<cr>', help: '' }]
      },
      run: (cli, a) => {
        if (a[0] === 'address') {
          if (a[1] === 'dhcp') {
            const bad = tooMany(cli, a, 2)
            if (bad) return bad
            cli.ctx.iface.addressMode = 'dhcp'; cli.ctx.iface.ip = null; cli.ctx.iface.mask = null
            return []
          }
          const [ip, mask] = [a[1], a[2]]
          if (!ip || !mask) return ['% Incomplete command.']
          const bad = tooMany(cli, a, 3)
          if (bad) return bad
          cli.ctx.iface.ip = ip
          cli.ctx.iface.mask = mask
          cli.ctx.iface.addressMode = 'static'
          return []
        }
        if (a[0] === 'nat') {
          if (a[1] === 'inside' || a[1] === 'outside') {
            const bad = tooMany(cli, a, 2)
            if (bad) return bad
            cli.ctx.iface.natRole = a[1]
            return []
          }
          return ['% Incomplete command.']
        }
        if (a[0] === 'helper-address') {
          if (!a[1]) return ['% Incomplete command.']
          { const bad = tooMany(cli, a, 2); if (bad) return bad }
          cli.ctx.iface.helperAddress = a[1]
          return []
        }
        if (a[0] === 'access-group') {
          const [aclId, dir] = [a[1], a[2]]
          if (!aclId || !dir) return ['% Incomplete command.']
          const bad = tooMany(cli, a, 3)
          if (bad) return bad
          if (dir === 'in') cli.ctx.iface.accessGroupIn = aclId
          else if (dir === 'out') cli.ctx.iface.accessGroupOut = aclId
          else return cli.invalid(dir)
          return []
        }
        if (a[0] === 'dhcp' && a[1] === 'snooping' && 'trust'.startsWith(a[2] || 'x') && a[2]) {
          const bad = tooMany(cli, a, 3); if (bad) return bad
          cli.ctx.iface.dhcpSnoopTrust = true; return []
        }
        if (a[0] === 'arp' && a[1] === 'inspection' && 'trust'.startsWith(a[2] || 'x') && a[2]) {
          const bad = tooMany(cli, a, 3); if (bad) return bad
          cli.ctx.iface.arpInspectTrust = true; return []
        }
        return cli.invalid(a[0])
      },
    },
    'description': { help: 'Interface description', argHelp: () => [{ name: 'LINE', help: 'Up to 240 characters describing this interface' }], run: (cli, a) => { cli.ctx.iface.description = a.join(' '); return [] } },
    'shutdown': {
      help: 'Shut down interface', noArgs: true,
      run: (cli) => {
        const i = cli.ctx.iface
        const [wasShut, hadProto] = [i.shutdown, i.lineProtocol]
        i.shutdown = true; i.lineProtocol = false
        return logIfaceState(cli.dev, i, wasShut, hadProto)
      },
    },
    'switchport': { help: 'Set switching mode', argHelp: switchportArgHelp, run: (cli, a) => switchportCmd(cli, a) },
    'ipv6': {
      help: 'IPv6 interface subcommands',
      argHelp: (cli, a) => a.length === 0
        ? [{ name: 'address', help: 'Configure IPv6 address on interface' }, { name: 'enable', help: 'Enable IPv6 on interface' }]
        : [{ name: 'X:X:X:X::X/<0-128>', help: 'IPv6 prefix' }],
      run: (cli, a) => {
        if ('enable'.startsWith(a[0] || 'x')) return []
        if (a[0] === 'address') {
          const spec = a[1]
          if (!spec) return ['% Incomplete command.']
          if ((a[2] || '').toLowerCase() === 'link-local') { return [] } // accepted, not tracked
          if (!spec.includes('/')) return ['% Incomplete command.']
          { const bad = tooMany(cli, a, 2); if (bad) return bad }
          const list = cli.ctx.iface.ipv6
          if (!list.includes(spec)) list.push(spec)
          return []
        }
        return cli.invalid(a[0])
      },
    },
    'cdp': { maxArgs: 1,
      help: 'CDP interface subcommands',
      argHelp: () => [{ name: 'enable', help: 'Enable CDP on interface' }],
      run: (cli, a) => { if ('enable'.startsWith(a[0] || 'x')) { cli.ctx.iface.cdpEnabled = true; return [] } return ['% Incomplete command.'] },
    },
    'lldp': { maxArgs: 1,
      help: 'LLDP interface subcommands',
      argHelp: () => [{ name: 'transmit', help: 'Enable LLDP transmit' }, { name: 'receive', help: 'Enable LLDP receive' }],
      run: (cli, a) => {
        if ('transmit'.startsWith(a[0] || 'x')) { cli.ctx.iface.lldpTx = true; return [] }
        if ('receive'.startsWith(a[0] || 'x')) { cli.ctx.iface.lldpRx = true; return [] }
        return ['% Incomplete command.']
      },
    },
    'channel-group': {
      help: 'Add interface to an EtherChannel',
      argHelp: (cli, a) => {
        if (a.length === 0) return [{ name: '<1-48>', help: 'Channel group number' }]
        if (a.length === 1) return [{ name: 'mode', help: 'Set EtherChannel mode' }]
        return [
          { name: 'active', help: 'Enable LACP unconditionally' },
          { name: 'passive', help: 'Enable LACP only if a partner is detected' },
          { name: 'on', help: 'Enable EtherChannel only (no negotiation)' },
        ]
      },
      run: (cli, a) => channelGroupCmd(cli, a),
    },
    'no': { help: 'Negate a command', run: (cli, a) => negate(cli, a) },
    exit: { help: 'Exit interface config', noArgs: true, run: (cli) => { cli.mode = 'config'; return [] } },
    end: { help: 'Return to privileged EXEC', noArgs: true, run: (cli) => { cli.mode = 'enable'; return [] } },
  },

  vlan: {
    name: { help: 'Set VLAN name', maxArgs: 1, run: (cli, a) => { cli.ctx.vlan.name = a[0] || cli.ctx.vlan.name; return [] } },
    'no': { help: 'Negate a command', run: (cli, a) => negate(cli, a) },
    exit: { help: 'Exit VLAN config', noArgs: true, run: (cli) => { cli.mode = 'config'; return [] } },
    end: { help: 'Return to privileged EXEC', noArgs: true, run: (cli) => { cli.mode = 'enable'; return [] } },
  },

  line: {
    'transport': {
      help: 'Define transport protocols for line',
      argHelp: (cli, a) => a.length === 0
        ? [{ name: 'input', help: 'Define which protocols to use when connecting to the terminal server' }, { name: 'output', help: 'Define which protocols to use for outgoing connections' }]
        : [{ name: 'ssh', help: 'TCP/IP SSH protocol' }, { name: 'telnet', help: 'TCP/IP Telnet protocol' }, { name: 'all', help: 'All protocols' }, { name: 'none', help: 'No protocols' }],
      run: (cli, a) => {
        const PROTOCOLS = ['ssh', 'telnet', 'all', 'none']
        if (a[0] === 'input' || a[0] === 'output') {
          const list = a.slice(1)
          if (!list.length) return ['% Incomplete command.']
          const junk = list.find(t => !PROTOCOLS.includes(t))
          if (junk) return cli.invalid(junk)
          if (a[0] === 'input') cli.ctx.line.transportInput = list
          else cli.ctx.line.transportOutput = list
          return []
        }
        return ['% Incomplete command.']
      },
    },
    'login': { maxArgs: 1,
      help: 'Enable password checking',
      argHelp: () => [{ name: 'local', help: 'Local password checking' }, { name: '<cr>', help: '' }],
      run: (cli, a) => { cli.ctx.line.login = (a[0] && 'local'.startsWith(a[0])) ? 'local' : 'password'; return [] },
    },
    'password': { help: 'Set a password', run: (cli, a) => { cli.ctx.line.password = a.join(' '); return [] } },
    'no': { help: 'Negate a command', run: (cli, a) => negate(cli, a) },
    exit: { help: 'Exit line config', noArgs: true, run: (cli) => { cli.mode = 'config'; return [] } },
    end: { help: 'Return to privileged EXEC', noArgs: true, run: (cli) => { cli.mode = 'enable'; return [] } },
  },

  dhcp: {
    'network': { maxArgs: 2,
      help: 'Network number and mask',
      argHelp: (cli, a) => a.length === 0 ? [{ name: 'A.B.C.D', help: 'Network number' }] : [{ name: 'A.B.C.D', help: 'Network mask' }],
      run: (cli, a) => { if (!a[0]) return ['% Incomplete command.']; cli.ctx.dhcpPool.network = a[0]; cli.ctx.dhcpPool.mask = a[1] || '255.255.255.0'; return [] },
    },
    'default-router': { help: 'Default routers', maxArgs: 1, run: (cli, a) => { if (!a[0]) return ['% Incomplete command.']; cli.ctx.dhcpPool.defaultRouter = a[0]; return [] } },
    'dns-server': { help: 'DNS servers', maxArgs: 1, run: (cli, a) => { if (!a[0]) return ['% Incomplete command.']; cli.ctx.dhcpPool.dnsServer = a[0]; return [] } },
    'no': { help: 'Negate a command', run: (cli, a) => negate(cli, a) },
    exit: { help: 'Exit DHCP pool config', noArgs: true, run: (cli) => { cli.mode = 'config'; return [] } },
    end: { help: 'Return to privileged EXEC', noArgs: true, run: (cli) => { cli.mode = 'enable'; return [] } },
  },

  router: {
    network: { maxArgs: 4,
      help: 'Enable routing on an IP network',
      argHelp: (cli, a) => {
        if (a.length === 0) return [{ name: 'A.B.C.D', help: 'Network number' }]
        if (a.length === 1) return [{ name: 'A.B.C.D', help: 'OSPF wildcard bits' }]
        if (a.length === 2) return [{ name: 'area', help: 'Set the OSPF area ID' }]
        if (a.length === 3) return [{ name: '<0-4294967295>', help: 'OSPF area ID' }]
        return [{ name: '<cr>', help: '' }]
      },
      run: (cli, a) => networkCmd(cli, a),
    },
    'router-id': { maxArgs: 1,
      help: 'Configure router identifier',
      argHelp: () => [{ name: 'A.B.C.D', help: 'OSPF router-id in IP address format' }],
      run: (cli, a) => { if (!a[0]) return ['% Incomplete command.']; cli.dev.ospf.routerId = a[0]; return [] },
    },
    'passive-interface': {
      help: 'Suppress routing updates on an interface',
      run: (cli, a) => {
        if (!a[0]) return ['% Incomplete command.']
        const canon = canonicalIface(a.join('')) || a.join(' ')
        if (!cli.dev.ospf.passive.includes(canon)) cli.dev.ospf.passive.push(canon)
        return []
      },
    },
    'no': { help: 'Negate a command', run: (cli, a) => negate(cli, a) },
    exit: { help: 'Exit router config', noArgs: true, run: (cli) => { cli.mode = 'config'; return [] } },
    end: { help: 'Return to privileged EXEC', noArgs: true, run: (cli) => { cli.mode = 'enable'; return [] } },
  },
}

// --- argument help providers -------------------------------------------------
// Each returns the list of valid NEXT tokens given the args already typed.

function showArgHelp(cli, a) {
  if (a.length === 0) {
    const opts = [
      { name: 'running-config', help: 'Current operating configuration' },
      { name: 'ip', help: 'IP information' },
      { name: 'cdp', help: 'CDP information' },
      { name: 'lldp', help: 'LLDP information' },
      { name: 'ntp', help: 'Network time protocol' },
      { name: 'ipv6', help: 'IPv6 information' },
      { name: 'access-lists', help: 'List access lists' },
      { name: 'version', help: 'System hardware and software status' },
    ]
    if (cli.dev.kind === 'switch') {
      opts.push({ name: 'vlan', help: 'VTP VLAN status' })
      opts.push({ name: 'etherchannel', help: 'EtherChannel information' })
      opts.push({ name: 'interfaces', help: 'Interface status and configuration' })
      opts.push({ name: 'port-security', help: 'Port security information' })
    }
    return opts
  }
  if (a[0] === 'ip') {
    if (a.length === 1) return [
      { name: 'interface', help: 'IP interface status and configuration' },
      { name: 'route', help: 'IP routing table' },
      { name: 'ospf', help: 'OSPF information' },
      { name: 'nat', help: 'NAT information' },
      { name: 'ssh', help: 'SSH server information' },
    ]
    if (a[1] === 'interface') return [{ name: 'brief', help: 'Brief summary of IP status' }]
    if (a[1] === 'ospf') return [{ name: 'neighbor', help: 'OSPF neighbor list' }]
    if (a[1] === 'nat') return [{ name: 'translations', help: 'Translation entries' }, { name: 'statistics', help: 'Translation statistics' }]
  }
  if (a[0] === 'cdp') return [{ name: 'neighbors', help: 'CDP neighbor entries' }]
  if (a[0] === 'cdp' && a[1] === 'neighbors') return [{ name: 'detail', help: 'Detailed neighbor information' }]
  if (a[0] === 'lldp') return [{ name: 'neighbors', help: 'LLDP neighbor entries' }]
  if (a[0] === 'etherchannel') return [{ name: 'summary', help: 'One-line summary per channel-group' }]
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
    { name: 'trunk', help: 'Set trunking characteristics of the interface' },
    { name: 'port-security', help: 'Security related command' },
  ]
  if (a[0] === 'port-security') {
    if (a.length === 1) return [
      { name: 'maximum', help: 'Max secure addresses' },
      { name: 'violation', help: 'Security violation mode' },
      { name: 'mac-address', help: 'Secure MAC address' },
      { name: '<cr>', help: '' },
    ]
    if (a[1] === 'violation') return [
      { name: 'shutdown', help: 'Shut down the port' },
      { name: 'restrict', help: 'Drop and log' },
      { name: 'protect', help: 'Drop silently' },
    ]
    if (a[1] === 'mac-address') return [{ name: 'sticky', help: 'Dynamically learn and stick MACs' }]
  }
  if (a[0] === 'mode') return [
    { name: 'access', help: 'Set trunking mode to ACCESS unconditionally' },
    { name: 'trunk', help: 'Set trunking mode to TRUNK unconditionally' },
  ]
  if (a[0] === 'access') {
    if (a.length === 1) return [{ name: 'vlan', help: 'Set VLAN when interface is in access mode' }]
    if (a[1] === 'vlan') return [{ name: '<1-4094>', help: 'VLAN ID of the VLAN when this port is in access mode' }]
  }
  if (a[0] === 'trunk') {
    if (a.length === 1) return [
      { name: 'native', help: 'Set trunking native characteristics' },
      { name: 'allowed', help: 'Set allowed VLAN characteristics' },
    ]
    if (a[1] === 'native') return [{ name: 'vlan', help: 'Set native VLAN when interface is in trunking mode' }]
    if (a[1] === 'allowed') return [{ name: 'vlan', help: 'Set allowed VLANs when interface is in trunking mode' }]
    if (a[2] === 'vlan') return [{ name: '<1-4094>', help: 'VLAN IDs of the allowed/native VLANs' }]
  }
  return [{ name: '<cr>', help: '' }]
}

// --- command handlers --------------------------------------------------------

// Snapshot running-config into savedConfig. Grading compares this snapshot to
// the live running-config, so saving after further edits is required to stay
// "saved" — exactly like copy run start on a real box.
function saveConfig(cli) {
  cli.dev.savedConfig = renderRunningConfig(cli.dev).join('\n')
}

function negate(cli, a) {
  if (!a.length) return ['% Incomplete command.']

  // Resolve the negated word against the same command table the positive form
  // uses, so abbreviations work: `no sh` is `no shutdown`, exactly as on IOS.
  // Matching on the raw string here is why `no sh` used to be a silent no-op.
  const table = COMMANDS[cli.mode] || {}
  const m = matchCommand(table, a[0])
  if (m.error) return cli.renderMatchError(m)
  const name = m.name

  if (cli.mode === 'config') {
    if (name === 'cdp' && 'run'.startsWith(a[1] || 'x')) { cli.dev.cdpEnabled = false; return [] }
    if (name === 'lldp' && 'run'.startsWith(a[1] || 'x')) { cli.dev.lldpEnabled = false; return [] }
  }
  if (cli.mode === 'line') {
    if (name === 'login') { cli.ctx.line.login = null; return [] }
    if (name === 'password') { cli.ctx.line.password = null; return [] }
    if (name === 'transport') {
      if ('input'.startsWith(a[1] || 'x')) { cli.ctx.line.transportInput = []; return [] }
      if ('output'.startsWith(a[1] || 'x')) { cli.ctx.line.transportOutput = []; return [] }
      return ['% Incomplete command.']
    }
  }
  if (cli.mode === 'vlan') {
    if (name === 'name') { cli.ctx.vlan.name = `VLAN${String(cli.ctx.vlan.id).padStart(4, '0')}`; return [] }
  }
  if (cli.mode === 'dhcp') {
    if (name === 'network') { cli.ctx.dhcpPool.network = null; cli.ctx.dhcpPool.mask = null; return [] }
    if (name === 'default-router') { cli.ctx.dhcpPool.defaultRouter = null; return [] }
    if (name === 'dns-server') { cli.ctx.dhcpPool.dnsServer = null; return [] }
  }
  // Trailing tokens are as invalid after `no` as before it.
  if (name === 'shutdown' || name === 'description') {
    const bad = tooMany(cli, a, 1)
    if (bad) return bad
  }
  if (cli.mode === 'iface') {
    if (name === 'shutdown') {
      const i = cli.ctx.iface
      const [wasShut, hadProto] = [i.shutdown, i.lineProtocol]
      i.shutdown = false
      // Line protocol only comes up if the port is actually cabled.
      i.lineProtocol = !!i.connected && (!!i.ip || cli.dev.kind === 'switch')
      return logIfaceState(cli.dev, i, wasShut, hadProto)
    }
    if (name === 'ip' && 'address'.startsWith(a[1] || 'x') && a[1]) { cli.ctx.iface.ip = null; cli.ctx.iface.mask = null; return [] }
    if (name === 'description') { cli.ctx.iface.description = null; return [] }
    if (name === 'cdp' && 'enable'.startsWith(a[1] || 'x')) { cli.ctx.iface.cdpEnabled = false; return [] }
    if (name === 'channel-group') {
      const cg = cli.ctx.iface.channelGroup
      if (cg) {
        const po = cli.dev.portChannels[cg.id]
        if (po) po.members = po.members.filter(m => m !== cli.ctx.iface.name)
        cli.ctx.iface.channelGroup = null
      }
      return []
    }
  }
  // Recognised command, but this sim has no undo for it. Say so rather than
  // silently reporting success on a command that did nothing.
  return [`% Negating "${name}" is not supported in this lablet`]
}

function channelGroupCmd(cli, a) {
  const id = parseInt(a[0], 10)
  if (!id || id < 1 || id > 48) return ['% Incomplete command.']
  if ((a[1] || '') !== 'mode' && !'mode'.startsWith(a[1] || 'x')) return ['% Incomplete command.']
  const mode = a[2]
  if (!['active', 'passive', 'on'].includes(mode)) return cli.invalid(mode)
  { const bad = tooMany(cli, a, 3); if (bad) return bad }
  const ifc = cli.ctx.iface
  ifc.channelGroup = { id, mode }
  if (!cli.dev.portChannels[id]) cli.dev.portChannels[id] = { id, members: [] }
  const po = cli.dev.portChannels[id]
  if (!po.members.includes(ifc.name)) po.members.push(ifc.name)
  return [`Creating a port-channel interface Port-channel ${id}`]
}

// Trailing tokens past position `n` are a parse error, not something to drop.
// Only for commands with fixed arity — `description`, `transport input <list>`
// and `access-list ...` legitimately take a variable tail.
function tooMany(cli, a, n) {
  return a.length > n ? cli.invalid(a[n]) : null
}

// CDP reports a native VLAN disagreement as soon as it hears the neighbour's
// advertisement. There is no timer here, so the warning is emitted when the
// configuration change creates the disagreement — which is when a real operator
// would see it appear on the console.
function cdpNativeWarning(cli, ifc) {
  if (!cli.net) return []
  const m = nativeVlanMismatch(cli.net, cli.dev.id, ifc.name)
  return m ? [nativeVlanMismatchLog(m)] : []
}

function switchportCmd(cli, a) {
  const ifc = cli.ctx.iface
  // Each form below consumes a fixed number of tokens. Anything after that is a
  // parse error in IOS, not something to quietly drop — "switchport mode trunk
  // native vlan 99" is two commands run together, and silently honouring only
  // the first half leaves the learner sure they configured something they did
  // not. `extra(n)` returns the caret error when tokens remain past position n.
  const extra = (n) => (a.length > n ? cli.invalid(a[n]) : null)

  if (a[0] === 'mode') {
    if (a[1] === 'access' || a[1] === 'trunk') {
      const bad = extra(2)
      if (bad) return bad
      ifc.mode = a[1]
      ifc.modeExplicit = true
      return cdpNativeWarning(cli, ifc)
    }
    return a[1] ? cli.invalid(a[1]) : ['% Incomplete command.']
  }
  if (a[0] === 'access' && a[1] === 'vlan') {
    const id = parseInt(a[2], 10)
    if (!id) return ['% Incomplete command.']
    const bad = extra(3)
    if (bad) return bad
    ifc.accessVlan = id
    return []
  }
  if (a[0] === 'trunk') {
    if (a[1] === 'native' && a[2] === 'vlan') {
      const id = parseInt(a[3], 10)
      if (!id) return ['% Incomplete command.']
      const bad = extra(4)
      if (bad) return bad
      ifc.trunkNativeVlan = id
      return cdpNativeWarning(cli, ifc)
    }
    if (a[1] === 'allowed' && a[2] === 'vlan') {
      const list = a[3]
      if (!list) return ['% Incomplete command.']
      const bad = extra(4)
      if (bad) return bad
      ifc.trunkAllowed = list.split(',').map(s => parseInt(s, 10)).filter(Boolean)
      return []
    }
    return a[1] ? cli.invalid(a[1]) : ['% Incomplete command.']
  }
  if (a[0] === 'port-security') {
    if (!ifc.portSecurity) ifc.portSecurity = { enabled: false, maximum: 1, violation: 'shutdown', sticky: false }
    const ps = ifc.portSecurity
    if (a.length === 1) { ps.enabled = true; return [] }
    if (a[1] === 'maximum') {
      const n = parseInt(a[2], 10)
      if (!n) return ['% Incomplete command.']
      const bad = extra(3)
      if (bad) return bad
      ps.maximum = n
      return []
    }
    if (a[1] === 'violation') {
      if (!['shutdown', 'restrict', 'protect'].includes(a[2])) return cli.invalid(a[2])
      const bad = extra(3)
      if (bad) return bad
      ps.violation = a[2]
      return []
    }
    if (a[1] === 'mac-address') {
      if (!'sticky'.startsWith(a[2] || 'x') || !a[2]) return a[2] ? cli.invalid(a[2]) : ['% Incomplete command.']
      const bad = extra(3)
      if (bad) return bad
      ps.sticky = true
      return []
    }
    return cli.invalid(a[1])
  }
  return cli.invalid(a[0])
}

// ipv6 route <prefix>/<len> <next-hop> [ad]
function ipv6RouteCmd(cli, a) {
  const [spec, nh] = [a[0], a[1]]
  if (!spec || !nh) return ['% Incomplete command.']
  if (!spec.includes('/')) return cli.invalid(spec)
  const p = splitPrefix(spec)
  if (!p) return cli.invalid(spec)
  const nhBig = ipv6ToBig(nh)
  if (nhBig === null) return cli.invalid(nh)
  const ad = a[2] ? parseInt(a[2], 10) : 1
  if (Number.isNaN(ad)) return cli.invalid(a[2])
  { const bad = tooMany(cli, a, 3); if (bad) return bad }
  const prefix = bigToIpv6(netV6(p.addr, p.len))
  cli.dev.ipv6Routes = cli.dev.ipv6Routes
    .filter(r => !(r.prefix === prefix && r.len === p.len && r.nextHop === nh))
  cli.dev.ipv6Routes.push({
    prefix, len: p.len, nextHop: nh, prefixBig: netV6(p.addr, p.len), ad,
  })
  return []
}

function ipConfigCmd(cli, a) {
  // ip route <prefix> <mask> <next-hop> [ad]
  if (a[0] === 'route') {
    const [prefix, mask, nh] = [a[1], a[2], a[3]]
    if (!prefix || !mask || !nh) return ['% Incomplete command.']
    const bad = tooMany(cli, a, 5)
    if (bad) return bad
    // The optional 5th token is the administrative distance — it must be one.
    if (a[4] != null && !/^\d+$/.test(a[4])) return cli.invalid(a[4])
    const ad = a[4] ? parseInt(a[4], 10) : 1
    cli.dev.routes = cli.dev.routes.filter(r => !(r.prefix === prefix && r.mask === mask && r.nextHop === nh))
    cli.dev.routes.push({ proto: 'S', prefix, mask, nextHop: nh, ad, metric: 0 })
    return []
  }
  // ip domain-name X  /  ip domain name X
  if (a[0] === 'domain-name') {
    if (!a[1]) return ['% Incomplete command.']
    const bad = tooMany(cli, a, 2)
    if (bad) return bad
    cli.dev.domainName = a[1]
    return []
  }
  if (a[0] === 'domain' && a[1] === 'name') { cli.dev.domainName = a[2] || null; return a[2] ? [] : ['% Incomplete command.'] }
  if (a[0] === 'ssh') return [] // ip ssh version 2 — accepted
  // ip dhcp ...
  if (a[0] === 'dhcp') {
    if (a[1] === 'pool') {
      const name = a[2]
      if (!name) return ['% Incomplete command.']
      { const bad = tooMany(cli, a, 3); if (bad) return bad }
      if (!cli.dev.dhcpPools[name]) cli.dev.dhcpPools[name] = { name, network: null, mask: null, defaultRouter: null, dnsServer: null }
      cli.ctx.dhcpPool = cli.dev.dhcpPools[name]
      cli.mode = 'dhcp'
      return []
    }
    if (a[1] === 'excluded-address') {
      if (!a[2]) return ['% Incomplete command.']
      const bad = tooMany(cli, a, 4)
      if (bad) return bad
      // The optional second address is a range end — it has to be an address.
      const isIp = (t) => /^\d{1,3}(\.\d{1,3}){3}$/.test(t)
      if (!isIp(a[2])) return cli.invalid(a[2])
      if (a[3] && !isIp(a[3])) return cli.invalid(a[3])
      cli.dev.dhcpExcluded.push(a[2])
      if (a[3]) cli.dev.dhcpExcluded.push(a[3])
      return []
    }
    if (a[1] === 'snooping') {
      if (!a[2]) { cli.dev.dhcpSnooping.enabled = true; return [] }
      if (a[2] === 'vlan') {
        const bad = tooMany(cli, a, 4)
        if (bad) return bad
        addVlanList(cli.dev.dhcpSnooping.vlans, a[3])
        return []
      }
      return cli.invalid(a[2])
    }
    return ['% Incomplete command.']
  }
  // ip nat ...
  if (a[0] === 'nat') return ipNatCmd(cli, a.slice(1))
  // ip arp inspection vlan <list>
  if (a[0] === 'arp' && a[1] === 'inspection' && a[2] === 'vlan') {
    const bad = tooMany(cli, a, 4)
    if (bad) return bad
    addVlanList(cli.dev.arpInspection.vlans, a[3])
    return []
  }
  return cli.invalid(a[0])
}

function addVlanList(arr, spec) {
  if (!spec) return
  // supports "10" and "10,20" and "10-12"
  for (const part of spec.split(',')) {
    const m = part.match(/^(\d+)-(\d+)$/)
    if (m) { for (let v = +m[1]; v <= +m[2]; v++) if (!arr.includes(v)) arr.push(v) }
    else { const v = parseInt(part, 10); if (v && !arr.includes(v)) arr.push(v) }
  }
}

// access-list <n> permit|deny ... — standard (1-99) or extended (100-199).
function aclCmd(cli, a) {
  const id = a[0]
  const action = a[1]
  const num = parseInt(id, 10)
  if (!num || (action !== 'permit' && action !== 'deny')) return ['% Incomplete command.']
  if (!cli.dev.acls[id]) cli.dev.acls[id] = []
  const rest = a.slice(2)
  if (num >= 1 && num <= 99) {
    const { addr } = parseAclAddr(rest, 0)
    cli.dev.acls[id].push({ kind: 'standard', action, src: addr })
  } else {
    const proto = rest[0]
    const s = parseAclAddr(rest, 1)
    const d = parseAclAddr(rest, s.next)
    cli.dev.acls[id].push({ kind: 'extended', action, proto, src: s.addr, dst: d.addr })
  }
  return []
}

// Parse an address spec: "any" | "host A.B.C.D" | "A.B.C.D wildcard".
function parseAclAddr(toks, i) {
  if (toks[i] === 'any') return { addr: { any: true }, next: i + 1 }
  if (toks[i] === 'host') return { addr: { ip: toks[i + 1], wildcard: '0.0.0.0' }, next: i + 2 }
  return { addr: { ip: toks[i], wildcard: toks[i + 1] || '0.0.0.0' }, next: i + 2 }
}

function ipNatCmd(cli, a) {
  // ip nat pool NAME start end netmask MASK
  if (a[0] === 'pool') {
    const [name, start, end] = [a[1], a[2], a[3]]
    if (!name || !start || !end) return ['% Incomplete command.']
    const bad = tooMany(cli, a, 6)
    if (bad) return bad
    const mask = (a[4] === 'netmask') ? a[5] : null
    cli.dev.nat.pools[name] = { name, start, end, mask }
    return []
  }
  // ip nat inside source static <local> <global>
  // ip nat inside source list <acl> pool <name> [overload]
  if (a[0] === 'inside' && a[1] === 'source') {
    if (a[2] === 'static') {
      const [local, global] = [a[3], a[4]]
      if (!local || !global) return ['% Incomplete command.']
      { const bad = tooMany(cli, a, 5); if (bad) return bad }
      cli.dev.nat.statics.push({ insideLocal: local, insideGlobal: global })
      return []
    }
    if (a[2] === 'list') {
      const acl = a[3]
      const poolIdx = a.indexOf('pool')
      const pool = poolIdx >= 0 ? a[poolIdx + 1] : null
      const overload = a.includes('overload')
      if (!acl || !pool) return ['% Incomplete command.']
      cli.dev.nat.insideSourceLists.push({ acl, pool, overload })
      return []
    }
  }
  return cli.invalid(a[0])
}

function cryptoCmd(cli, a) {
  // crypto key generate rsa [general-keys] [modulus N]
  if (a[0] === 'key' && a[1] === 'generate' && 'rsa'.startsWith(a[2] || 'x')) {
    if (!cli.dev.domainName) return ['% Please define a domain-name first.']
    const modIdx = a.indexOf('modulus')
    const modulus = modIdx >= 0 ? parseInt(a[modIdx + 1], 10) : 1024
    cli.dev.rsaKey = { modulus }
    return [
      `The name for the keys will be: ${cli.dev.hostname}.${cli.dev.domainName}`,
      `% The key modulus size is ${modulus} bits`,
      `% Generating ${modulus} bit RSA keys, keys will be non-exportable...`,
      '[OK]',
    ]
  }
  return ['% Incomplete command.']
}

function ensureLine(dev, type) {
  if (!dev.lines[type]) dev.lines[type] = {}
  return dev.lines[type]
}

function networkCmd(cli, a) {
  // network <ip> <wildcard> area <id>
  const [ip, wc] = [a[0], a[1]]
  if (!ip || !wc) return ['% Incomplete command.']
  if (!'area'.startsWith(a[2] || 'x')) return cli.invalid(a[2])
  const area = parseInt(a[3], 10)
  if (Number.isNaN(area)) return ['% Incomplete command.']
  cli.dev.ospf.networks.push({ ip, wildcard: wc, area })
  return []
}

const KNOWN_SHOW_ROOTS = new Set(['ip', 'ipv6', 'ntp', 'cdp', 'lldp', 'interfaces', 'interface', 'int'])

function showCmd(cli, a) {
  const sub = (a[0] || '').toLowerCase()
  // Bare `show` is incomplete, not invalid. Without this guard every
  // ''.startsWith() test below is vacuously true and the first one wins —
  // which made `show` on its own print the version banner.
  if (!sub) return ['% Incomplete command.']
  if ('running-config'.startsWith(sub) && sub.length >= 3) return renderRunningConfig(cli.dev)
  if (sub === 'run') return renderRunningConfig(cli.dev)
  if (sub === 'interfaces' || sub === 'interface' || sub === 'int') {
    const s2 = (a[1] || '').toLowerCase()
    if (s2 && 'trunk'.startsWith(s2)) {
      observe(cli.dev, 'interfaces trunk')
      return renderInterfacesTrunk(cli.dev)
    }
    // `show interfaces` (all) or `show interfaces <name>` (one). IOS parses the
    // interface name as part of the grammar, so an unknown one is a caret error.
    const name = a[1]
    if (name) {
      const canon = canonicalIface(name)
      if (!canon || !cli.dev.interfaces[canon]) return cli.invalid(name)
    }
    observe(cli.dev, 'interfaces')
    return renderInterfaces(cli.dev, name || null)
  }
  if (sub === 'ip') {
    const s2 = (a[1] || '').toLowerCase()
    if (!s2) return ['% Incomplete command.']
    if ('interface'.startsWith(s2) && a[2] && 'brief'.startsWith((a[2] || '').toLowerCase())) {
      observe(cli.dev, 'ip interface brief')
      return renderIpIntBrief(cli.dev)
    }
    if (s2 === 'ssh') { observe(cli.dev, 'ip ssh'); return renderIpSsh(cli.dev) }
    if (s2 === 'nat') {
      const s3 = (a[2] || '').toLowerCase()
      if ('statistics'.startsWith(s3) && s3.length >= 1) {
        observe(cli.dev, 'ip nat statistics')
        return [`Total active translations: ${(cli.dev.nat?.statics.length) || 0}`]
      }
      observe(cli.dev, 'ip nat translations')
      return renderNatTranslations(cli.dev, cli.net)
    }
    if ('route'.startsWith(s2) && s2.length >= 1) {
      observe(cli.dev, 'ip route')
      return renderIpRoute(cli.dev, cli.net)
    }
    if ('ospf'.startsWith(s2) && s2.length >= 1) {
      const s3 = (a[2] || '').toLowerCase()
      if ('neighbor'.startsWith(s3) && s3.length >= 1) {
        observe(cli.dev, 'ip ospf neighbor')
        return renderOspfNeighbors(cli.dev, cli.net)
      }
      return [`Routing Process "ospf ${cli.dev.ospf?.pid ?? ''}" with ID ${cli.dev.ospf?.routerId ?? '(unset)'}`]
    }
  }
  if (sub === 'ntp') {
    const s2 = (a[1] || '').toLowerCase()
    if ('associations'.startsWith(s2) && s2.length >= 1) {
      observe(cli.dev, 'ntp associations')
      return renderNtpAssociations(cli.dev, cli.net)
    }
    observe(cli.dev, 'ntp status')
    return renderNtpStatus(cli.dev, cli.net)
  }
  if (sub === 'vlan') { observe(cli.dev, 'vlan'); return renderVlanBrief(cli.dev) }
  if (sub === 'ipv6') {
    const s2 = (a[1] || '').toLowerCase()
    if (s2 && 'route'.startsWith(s2)) {
      observe(cli.dev, 'ipv6 route')
      return renderIpv6Route(cli.dev, cli.net)
    }
    observe(cli.dev, 'ipv6 interface brief')
    return renderIpv6IntBrief(cli.dev)
  }
  if ('access-lists'.startsWith(sub) && sub.length >= 4) {
    observe(cli.dev, 'access-lists')
    return renderAccessLists(cli.dev)
  }
  if ('port-security'.startsWith(sub) && sub.length >= 4) {
    observe(cli.dev, 'port-security')
    return renderPortSecurity(cli.dev)
  }
  if (sub === 'cdp') {
    const s2 = (a[1] || '').toLowerCase()
    if ('neighbors'.startsWith(s2) && s2.length >= 1) {
      const detail = 'detail'.startsWith((a[2] || 'x').toLowerCase()) && a[2]
      observe(cli.dev, 'cdp neighbors')
      return renderCdpNeighbors(cli.dev, cli.net, !!detail)
    }
    return ['Global CDP information:', `        CDP is ${cli.dev.cdpEnabled ? 'enabled' : 'not enabled'} globally`]
  }
  if (sub === 'lldp') {
    const s2 = (a[1] || '').toLowerCase()
    if ('neighbors'.startsWith(s2) && s2.length >= 1) {
      observe(cli.dev, 'lldp neighbors')
      return renderLldpNeighbors(cli.dev, cli.net)
    }
    return ['Global LLDP Information:', `    Status: ${cli.dev.lldpEnabled ? 'ACTIVE' : 'INACTIVE'}`]
  }
  if ('etherchannel'.startsWith(sub) && sub.length >= 4) {
    observe(cli.dev, 'etherchannel summary')
    return renderEtherchannelSummary(cli.dev, cli.net)
  }
  if ('version'.startsWith(sub)) return ['Cisco IOS Software (CCNA Lablets simulated), Version 15.x', `${cli.dev.hostname} uptime is 0 minutes`]
  // Mark the deepest token reached: `show ip bogus` should flag "bogus", not "ip".
  return cli.invalid(KNOWN_SHOW_ROOTS.has(sub) && a[1] ? a[1] : a[0])
}

// Device-sourced ping — delegates to the routing engine (see l3.js).
function pingFromDevice(net, dev, target) {
  return devicePing(net, dev.id, target)
}

function pingCmd(cli, a) {
  const target = a[0]
  if (!target) return ['% Incomplete command.']
  // Keyed by target: pinging something else is not the verification the task
  // asked for. Recorded whether or not the ping succeeds — a failed ping is a
  // legitimate result to verify (see the ACL lablet).
  observe(cli.dev, `ping ${target.toLowerCase()}`)
  const header = [
    `Type escape sequence to abort.`,
    `Sending 5, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:`,
  ]
  if (!cli.net) {
    return [...header, `.....`, `Success rate is 0 percent (0/5)`]
  }
  // IPv6 target (contains ':') — same-link reachability.
  if (target.includes(':')) {
    const res6 = pingIpv6(cli.net, cli.dev.id, target)
    return [...header, res6.ok ? '!!!!!' : '.....', res6.ok
      ? 'Success rate is 100 percent (5/5), round-trip min/avg/max = 1/2/4 ms'
      : 'Success rate is 0 percent (0/5)']
  }
  // A switch/router pings from itself. We approximate by treating any device
  // interface IP in the destination's subnet as the source. Full L3 ping from
  // network devices comes with the routing phase; hosts use the host console.
  const res = pingFromDevice(cli.net, cli.dev, target)
  const marks = res.ok ? '!!!!!' : '.....'
  const stats = res.ok
    ? 'Success rate is 100 percent (5/5), round-trip min/avg/max = 1/2/4 ms'
    : 'Success rate is 0 percent (0/5)'
  return [...header, marks, stats]
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
