import { useState, useCallback, useRef, useEffect } from 'react'
import Terminal from './components/Terminal.jsx'
import TopologyView from './components/TopologyView.jsx'
import TaskPanel from './components/TaskPanel.jsx'
import { getScenario, scenarios } from './scenarios/index.js'
import { grade, scorePct } from './engine/grader.js'
import { getCompletions, getAllCompletions, bumpCompletions, resetCompletions, getHintsEnabled, setHintsEnabled } from './storage.js'

function initBuffers(sim) {
  const b = {}
  for (const id of Object.keys(sim.consoles)) {
    b[id] = [`${id} console — press a key and start typing.`, '']
  }
  return b
}
function initHistories(sim) {
  const h = {}
  for (const id of Object.keys(sim.consoles)) h[id] = []
  return h
}

export default function App() {
  const [scenarioId, setScenarioId] = useState(scenarios[0].id)
  const scenario = getScenario(scenarioId)

  const [sim, setSim] = useState(() => scenario.build())
  const deviceIds = Object.keys(sim.consoles)
  const [active, setActive] = useState(deviceIds[0])
  const [buffers, setBuffers] = useState(() => initBuffers(sim))
  const [histories, setHistories] = useState(() => initHistories(sim))
  const [results, setResults] = useState(() => grade(scenario, sim.net))
  const [completions, setCompletions] = useState(() => getCompletions(scenarioId))
  // Every lablet's count, so the picker can show how many times each is done.
  const [allCompletions, setAllCompletions] = useState(() => getAllCompletions())
  const [hintsEnabled, setHints] = useState(() => getHintsEnabled())

  function toggleHints() {
    const next = !hintsEnabled
    setHints(next)
    setHintsEnabled(next)
  }
  // Whether the current attempt already counted, so re-hitting 100% (e.g. after
  // editing then re-saving) doesn't inflate the count. Reset by "Reset lab".
  const countedRef = useRef(false)

  const runCommand = useCallback((devId, cmd) => {
    const cli = sim.consoles[devId]
    // A password line is never echoed back — only the prompt that asked for it.
    const wasMasked = cli.masked
    const echoed = wasMasked ? cli.prompt() : `${cli.prompt()}${cmd}`
    let out = []
    try {
      out = cli.execute(cmd)
    } catch (e) {
      out = [`% engine error: ${e.message}`]
    }
    setBuffers(b => ({ ...b, [devId]: [...b[devId], echoed, ...out] }))
    // Passwords must not land in the recallable command history either.
    if (cmd.trim() && !cmd.trim().endsWith('?') && !wasMasked) {
      setHistories(h => ({ ...h, [devId]: [...h[devId], cmd] }))
    }
    const newResults = grade(scenario, sim.net)
    setResults(newResults)
    if (scorePct(newResults) === 100 && !countedRef.current) {
      countedRef.current = true
      setCompletions(bumpCompletions(scenario.id))
      setAllCompletions(getAllCompletions())
    }
  }, [sim, scenario, scenarioId])

  function reset() {
    const s = scenario.build()
    setSim(s)
    setActive(Object.keys(s.consoles)[0])
    setBuffers(initBuffers(s))
    setHistories(initHistories(s))
    setResults(grade(scenario, s.net))
    countedRef.current = false // fresh attempt can count again
  }

  function resetCount() {
    setCompletions(resetCompletions(scenario.id))
    setAllCompletions(getAllCompletions())
  }

  // Rebuild the whole session when the selected scenario changes (skip mount).
  const didMount = useRef(false)
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return }
    const s = scenario.build()
    setSim(s)
    setActive(Object.keys(s.consoles)[0])
    setBuffers(initBuffers(s))
    setHistories(initHistories(s))
    setResults(grade(scenario, s.net))
    countedRef.current = false
    setCompletions(getCompletions(scenario.id))
  }, [scenarioId]) // eslint-disable-line react-hooks/exhaustive-deps

  const cli = sim.consoles[active]
  // How many distinct lablets have been finished at least once.
  const doneCount = scenarios.filter(s => (allCompletions[s.id] || 0) > 0).length

  return (
    <div className="app">
      <header className="app-header">
        <h1>CCNA Lablets</h1>
        <select className="scenario-select" value={scenarioId}
          onChange={e => setScenarioId(e.target.value)}>
          {scenarios.map(s => {
            const n = allCompletions[s.id] || 0
            // Native <option> can't be styled, so the count rides in the text.
            return <option key={s.id} value={s.id}>{n ? `${s.title} — ${n}×` : s.title}</option>
          })}
        </select>
        <span className="done-total">{doneCount}/{scenarios.length} done</span>
        <span className="app-spacer" />
        <button className={`btn mode-toggle ${hintsEnabled ? 'study' : 'exam'}`} onClick={toggleHints}
          title="Study mode shows hints; Exam mode hides them">
          {hintsEnabled ? '📖 Study mode' : '📝 Exam mode'}
        </button>
        <button className="btn" onClick={reset}>Reset lab</button>
      </header>

      <main className="app-main">
        <div className="left-col">
          <TopologyView layout={sim.layout} devices={sim.net.devices} links={sim.net.links}
            active={active} onSelect={setActive} />

          <div className="device-tabs">
            {deviceIds.map(id => (
              <button key={id}
                className={`tab ${id === active ? 'active' : ''} tab-${sim.net.devices[id]?.kind}`}
                onClick={() => setActive(id)}>
                {id}
              </button>
            ))}
          </div>

          <Terminal
            key={active}
            prompt={cli.prompt()}
            lines={buffers[active]}
            history={histories[active]}
            onSubmit={cmd => runCommand(active, cmd)}
            complete={cli.complete && !cli.masked ? (line => cli.complete(line)) : null}
            masked={!!cli.masked}
          />
        </div>

        <aside className="right-col">
          <div className="intro">
            <h2>{scenario.title}</h2>
            <pre className="intro-text">{scenario.intro.join('\n')}</pre>
          </div>
          <TaskPanel scenario={scenario} results={results} score={scorePct(results)}
            completions={completions} onResetCount={resetCount} hintsEnabled={hintsEnabled} />
        </aside>
      </main>
    </div>
  )
}
