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
