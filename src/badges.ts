import type { Grade, QuizResult, Rank } from './comment/state.js'

export interface LabelSpec {
  name: string
  color: string
  description: string
}

/** Ranks, from the first step aboard to the top. */
export const RANK_LABELS: Record<Rank, LabelSpec> = {
  deckhand: {
    name: '⚓ Deckhand',
    color: 'c5def5',
    description: 'OwnerShip: answered the quiz about their own changes'
  },
  navigator: {
    name: '🧭 Navigator',
    color: '7ab8e8',
    description: 'OwnerShip: no answer left missing'
  },
  captain: {
    name: '🏴‍☠️ Captain',
    color: '1d4f91',
    description: 'OwnerShip: every answer solid'
  }
}

export const DEAD_RECKONING_LABEL: LabelSpec = {
  name: '🗺️ Dead Reckoning',
  color: 'e8d5a8',
  description: 'OwnerShip: answered without AI help (on honour)'
}

const RANK_ORDER: Record<Rank, number> = { deckhand: 0, navigator: 1, captain: 2 }

/** Captain: every answer solid. Navigator: nothing missing. Deckhand: showed up and answered. */
export function rankFor(grades: readonly Grade[]): Rank {
  if (grades.length > 0 && grades.every(grade => grade === 'solid')) return 'captain'
  if (grades.every(grade => grade !== 'missing')) return 'navigator'
  return 'deckhand'
}

function score(grades: readonly Grade[]): number {
  return grades.reduce(
    (sum, grade) => sum + (grade === 'solid' ? 2 : grade === 'partial' ? 1 : 0),
    0
  )
}

/** Whether a new attempt beats the previous best (higher rank, or same rank with a better score). */
export function isBetter(next: QuizResult, previous: QuizResult | undefined): boolean {
  if (!previous) return true
  const byRank = RANK_ORDER[next.rank] - RANK_ORDER[previous.rank]
  if (byRank !== 0) return byRank > 0
  return score(next.grades) > score(previous.grades)
}

export function countGrade(grades: readonly Grade[], grade: Grade): number {
  return grades.filter(g => g === grade).length
}
