export function fuzzyMatch(query: string, target: string): { score: number; matched: boolean } {
  if (!query) return { score: 0, matched: true }
  if (!target) return { score: 0, matched: false }

  const q = query.toLowerCase()
  const t = target.toLowerCase()

  let qi = 0
  let score = 0
  let lastMatchIdx = -1
  let consecutiveBonus = 0

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 10
      if (lastMatchIdx === ti - 1) {
        consecutiveBonus += 5
        score += consecutiveBonus
      } else {
        consecutiveBonus = 0
      }
      if (ti === 0 || t[ti - 1] === '/' || t[ti - 1] === '.' || t[ti - 1] === '-' || t[ti - 1] === '_') {
        score += 15
      }
      lastMatchIdx = ti
      qi++
    }
  }

  if (qi < q.length) return { score: 0, matched: false }

  score -= (target.length - query.length) * 0.1

  return { score, matched: true }
}

// Returns 0-based indices of `query` characters matched inside `target` (case-insensitive).
export function fuzzyMatchIndices(query: string, target: string): number[] {
  const indices: number[] = []
  if (!query) return indices
  if (!target) return indices
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti)
      qi++
    }
  }
  return qi === q.length ? indices : []
}

export function fuzzySort<T>(query: string, items: T[], getText: (item: T) => string): T[] {
  return items
    .map(item => ({ item, ...fuzzyMatch(query, getText(item)) }))
    .filter(x => x.matched)
    .sort((a, b) => b.score - a.score)
    .map(x => x.item)
}
