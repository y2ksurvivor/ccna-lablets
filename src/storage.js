// Per-scenario completion counts, persisted in the browser (localStorage).
// Guarded so it degrades gracefully if storage is unavailable (private mode).

const KEY = 'ccna-lablets:completions'

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {}
  } catch {
    return {}
  }
}

function writeAll(obj) {
  try {
    localStorage.setItem(KEY, JSON.stringify(obj))
  } catch {
    /* storage unavailable — counts just won't persist this session */
  }
}

export function getCompletions(scenarioId) {
  const n = readAll()[scenarioId]
  return Number.isFinite(n) ? n : 0
}

// All counts at once, for showing every lablet's tally in the picker.
export function getAllCompletions() {
  const all = readAll()
  const out = {}
  for (const [id, n] of Object.entries(all)) if (Number.isFinite(n)) out[id] = n
  return out
}

export function bumpCompletions(scenarioId) {
  const all = readAll()
  all[scenarioId] = (Number.isFinite(all[scenarioId]) ? all[scenarioId] : 0) + 1
  writeAll(all)
  return all[scenarioId]
}

export function resetCompletions(scenarioId) {
  const all = readAll()
  all[scenarioId] = 0
  writeAll(all)
  return 0
}

// Study mode (hints available) vs Exam mode (hints hidden).
const MODE_KEY = 'ccna-lablets:hints-enabled'

export function getHintsEnabled() {
  try {
    return localStorage.getItem(MODE_KEY) !== 'false' // default: study mode on
  } catch {
    return true
  }
}

export function setHintsEnabled(on) {
  try {
    localStorage.setItem(MODE_KEY, on ? 'true' : 'false')
  } catch {
    /* ignore */
  }
}
