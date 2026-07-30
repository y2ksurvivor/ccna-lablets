import { useState, useRef, useEffect } from 'react'

// A console attached to one CLI instance. Renders scrollback and an input line
// with the live prompt. Handles Enter (execute), Up/Down (history), and Tab
// (completion). `?` help works because the CLI treats a trailing ? specially.
export default function Terminal({ cli, deviceName }) {
  const [lines, setLines] = useState([`Press RETURN to get started.`, ''])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState([])
  const [histIdx, setHistIdx] = useState(-1)
  const inputRef = useRef(null)
  const scrollRef = useRef(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [lines])

  function run(cmd) {
    const promptStr = cli.prompt()
    const echoed = `${promptStr}${cmd}`
    let out = []
    try {
      out = cli.execute(cmd)
    } catch (e) {
      out = [`% engine error: ${e.message}`]
    }
    setLines(prev => [...prev, echoed, ...out])
    if (cmd.trim()) setHistory(prev => [...prev, cmd])
    setHistIdx(-1)
  }

  function onKeyDown(e) {
    if (e.key === 'Enter') {
      run(input)
      setInput('')
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (history.length === 0) return
      const idx = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1)
      setHistIdx(idx)
      setInput(history[idx])
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (histIdx === -1) return
      const idx = histIdx + 1
      if (idx >= history.length) { setHistIdx(-1); setInput('') }
      else { setHistIdx(idx); setInput(history[idx]) }
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const completed = cli.complete(input)
      if (completed) setInput(completed)
    }
  }

  return (
    <div className="terminal" onClick={() => inputRef.current?.focus()}>
      <div className="term-titlebar">{deviceName} — console</div>
      <div className="term-scroll" ref={scrollRef}>
        {lines.map((l, i) => (
          <div className="term-line" key={i}>{l === '' ? ' ' : l}</div>
        ))}
        <div className="term-inputline">
          <span className="term-prompt">{cli.prompt()}</span>
          <input
            ref={inputRef}
            className="term-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoFocus
          />
        </div>
      </div>
    </div>
  )
}
