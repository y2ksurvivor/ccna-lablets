// Live task list with pass/fail, graded after every command. Shows the overall
// score and a per-task hint you can reveal when stuck.
import { useState } from 'react'

export default function TaskPanel({ scenario, results, score }) {
  return (
    <div className="tasks">
      <div className="tasks-header">
        <h2>Tasks</h2>
        <span className={`score ${score === 100 ? 'done' : ''}`}>{score}%</span>
      </div>
      <div className="tasks-blueprint">
        {scenario.blueprint.map((b, i) => <span key={i} className="bp-chip">{b}</span>)}
      </div>
      <ol className="task-list">
        {results.map(r => <TaskItem key={r.id} r={r} />)}
      </ol>
      {score === 100 && <div className="tasks-complete">✓ Lablet complete — nicely done.</div>}
    </div>
  )
}

function TaskItem({ r }) {
  const [showHint, setShowHint] = useState(false)
  return (
    <li className={`task ${r.pass ? 'pass' : 'fail'}`}>
      <span className="task-check">{r.pass ? '✓' : '○'}</span>
      <div className="task-body">
        <span className="task-text">{r.text}</span>
        {r.hint && (
          <div className="task-hint-row">
            <button className="hint-btn" onClick={() => setShowHint(s => !s)}>
              {showHint ? 'hide hint' : 'hint'}
            </button>
            {showHint && <code className="task-hint">{r.hint}</code>}
          </div>
        )}
      </div>
    </li>
  )
}
