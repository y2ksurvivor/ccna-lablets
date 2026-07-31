import { vlanBasics } from './vlan-basics.js'
import { discoveryProtocols } from './discovery-protocols.js'
import { etherchannel } from './etherchannel.js'

// Registry of available lablets. More get added per blueprint domain.
export const scenarios = [vlanBasics, discoveryProtocols, etherchannel]

export function getScenario(id) {
  return scenarios.find(s => s.id === id) || scenarios[0]
}
