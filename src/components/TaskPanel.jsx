// Live task list with pass/fail, graded after every command. Shows the overall
// score, a completion counter, and two-tier hints (nudge -> exact commands)
// that are only offered in Study mode.
import { useState } from 'react'

export default function TaskPanel({ scenario, results, score, completions, onResetCount, hintsEnabled }) {
  return (
    <div className="tasks">
      <div className="tasks-header">
        <h2>Tasks</h2>
        <span className={`score ${score === 100 ? 'done' : ''}`}>{score}%</span>
      </div>
      <div className="completions-row">
        <span className="completions">
          Completed <strong>{completions}</strong> {completions === 1 ? 'time' : 'times'}
        </span>
        {completions > 0 && (
          <button className="reset-count-btn" onClick={onResetCount} title="Reset completion count to zero">
            reset count
          </button>
        )}
      </div>
      <div className="tasks-blueprint">
        {scenario.blueprint.map((b, i) => <span key={i} className="bp-chip">{b}</span>)}
      </div>
      <ol className="task-list">
        {results.map(r => <TaskItem key={r.id} r={r} hintsEnabled={hintsEnabled} />)}
      </ol>
      {score === 100 && <div className="tasks-complete">✓ Lablet complete — nicely done.</div>}
    </div>
  )
}

// level: 0 = hidden, 1 = nudge shown, 2 = commands shown
function TaskItem({ r, hintsEnabled }) {
  const [level, setLevel] = useState(0)
  const hints = r.hints || []
  const hasNudge = hints.length >= 1
  const hasCommands = hints.length >= 2

  return (
    <li className={`task ${r.pass ? 'pass' : 'fail'}`}>
      <span className="task-check">{r.pass ? '✓' : '○'}</span>
      <div className="task-body">
        <span className="task-text">{r.text}</span>

        {hintsEnabled && hasNudge && (
          <div className="task-hint-row">
            {level === 0 && (
              <button className="hint-btn" onClick={() => setLevel(1)}>hint</button>
            )}
            {level >= 1 && (
              <button className="hint-btn" onClick={() => setLevel(0)}>hide</button>
            )}
            {level >= 1 && hasCommands && level < 2 && (
              <button className="hint-btn more" onClick={() => setLevel(2)}>show commands</button>
            )}
          </div>
        )}

        {hintsEnabled && level >= 1 && (
          <div className="hint-content">
            <div className="hint-nudge">{hints[0]}</div>
            {level >= 2 && hasCommands && (
              <code className="task-hint">{hints[1]}</code>
            )}
          </div>
        )}
      </div>
    </li>
  )
}
