import { vlanBasics } from './vlan-basics.js'
import { discoveryProtocols } from './discovery-protocols.js'
import { etherchannel } from './etherchannel.js'
import { staticRouting } from './static-routing.js'
import { ospfLab } from './ospf.js'
import { sshLab } from './ssh.js'
import { ntpLab } from './ntp.js'
import { dhcpLab } from './dhcp.js'
import { natLab } from './nat.js'
import { deviceHardening } from './device-hardening.js'
import { aclLab } from './acl.js'
import { l2Security } from './l2-security.js'

// Registry of available lablets, grouped loosely by blueprint domain.
export const scenarios = [
  // Network Access (2.x)
  vlanBasics, discoveryProtocols, etherchannel,
  // IP Connectivity (3.x)
  staticRouting, ospfLab,
  // IP Services (4.x)
  sshLab, ntpLab, dhcpLab, natLab,
  // Security (5.x)
  deviceHardening, aclLab, l2Security,
]

export function getScenario(id) {
  return scenarios.find(s => s.id === id) || scenarios[0]
}
