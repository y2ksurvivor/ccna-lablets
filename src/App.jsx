import { useMemo } from 'react'
import Terminal from './components/Terminal.jsx'
import { createDevice } from './engine/device.js'
import { CLI } from './engine/cli.js'

// Phase 0/1 vertical slice: a single switch console you can actually configure.
// Multi-device topology + task panel arrive in Phases 2–3.
export default function App() {
  const cli = useMemo(() => {
    const sw = createDevice({ kind: 'switch', hostname: 'Switch' })
    return new CLI(sw)
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <h1>CCNA Lablets</h1>
        <span className="app-sub">Cisco CLI simulator · Phase 1 vertical slice</span>
      </header>
      <main className="app-main">
        <Terminal cli={cli} deviceName="Switch" />
        <aside className="app-side">
          <h2>Try it</h2>
          <p>The CLI is live and mutates real device state. Try:</p>
          <pre>{`enable
configure terminal
hostname SW1
vlan 10
 name SALES
exit
interface gi0/1
 switchport mode access
 switchport access vlan 10
exit
do show vlan
do show run`}</pre>
          <p className="muted">Abbreviations (<code>conf t</code>, <code>int gi0/1</code>),
          <code> ?</code> help, Tab completion, and command history all work.</p>
        </aside>
      </main>
    </div>
  )
}
