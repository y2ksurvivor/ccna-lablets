// A tiny PC console. Not IOS — just what an endpoint needs so learners can
// verify connectivity the way the exam expects (ping from a PC) and read the
// host's IP settings. Shares the Terminal's execute()/prompt() shape so the
// same component drives it.

import { ping } from './l3.js'

export class HostCLI {
  constructor(host, net) {
    this.dev = host
    this.net = net
  }

  prompt() {
    return `${this.dev.hostname}> `
  }

  execute(line) {
    const raw = line.trim()
    if (raw === '') return []
    const toks = raw.split(/\s+/)
    const cmd = toks[0].toLowerCase()

    if (cmd === 'ping') {
      const target = toks[1]
      if (!target) return ['Usage: ping <ip-address>']
      return this.ping(target)
    }
    if (cmd === 'ipconfig' || cmd === 'ifconfig') return this.ipconfig()
    return this.unknown(toks[0])
  }

  ping(target) {
    const res = ping(this.net, this.dev.id, target)
    const out = [`Pinging ${target} with 32 bytes of data:`]
    if (res.ok) {
      for (let i = 0; i < 4; i++) out.push(`Reply from ${target}: bytes=32 time<1ms TTL=128`)
      out.push('', `Ping statistics for ${target}:`, `    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),`)
    } else {
      for (let i = 0; i < 4; i++) out.push('Request timed out.')
      out.push('', `Ping statistics for ${target}:`, `    Packets: Sent = 4, Received = 0, Lost = 4 (100% loss),`)
      out.push(`    (${res.reason})`)
    }
    return out
  }

  ipconfig() {
    return [
      '',
      'Ethernet adapter Local Area Connection:',
      '',
      `   IPv4 Address. . . . . . . . . . . : ${this.dev.ip || '(none)'}`,
      `   Subnet Mask . . . . . . . . . . . : ${this.dev.mask || '(none)'}`,
      `   Default Gateway . . . . . . . . . : ${this.dev.gateway || '(none)'}`,
      '',
    ]
  }

  unknown(cmd) {
    return [`'${cmd}' is not recognized. Try: ping <ip>, ipconfig`]
  }
}
