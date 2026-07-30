import { vlanBasics } from './vlan-basics.js'

// Registry of available lablets. More get added per blueprint domain.
export const scenarios = [vlanBasics]

export function getScenario(id) {
  return scenarios.find(s => s.id === id) || scenarios[0]
}
