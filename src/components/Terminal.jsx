import { useState, useRef, useEffect } from 'react'

// Controlled console. Scrollback (`lines`) and `history` live in App so each
// device keeps its own buffer across tab switches. Local state is just the
// current input line and history cursor. Handles Enter, Up/Down, Tab, and the
// IOS behavior of redisplaying the typed line after a `?` query.
export default function Terminal({ prompt, lines, history, onSubmit, complete }) {
  const [input, setInput] = useState('')
  const [histIdx, setHistIdx] = useState(-1)
  const inputRef = useRef(null)
  const scrollRef = useRef(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [lines])

  function onKeyDown(e) {
    if (e.key === 'Enter') {
      onSubmit(input)
      if (input.trim().endsWith('?')) {
        setInput(input.slice(0, input.lastIndexOf('?')))
      } else {
        setInput('')
      }
      setHistIdx(-1)
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
      const completed = complete ? complete(input) : null
      if (completed) setInput(completed)
    }
  }

  return (
    <div className="terminal" onClick={() => inputRef.current?.focus()}>
      <div className="term-scroll" ref={scrollRef}>
        {lines.map((l, i) => (
          <div className="term-line" key={i}>{l === '' ? ' ' : l}</div>
        ))}
        <div className="term-inputline">
          <span className="term-prompt">{prompt}</span>
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
