import { describe, expect, it } from 'vitest'
import { decodeState, encodeState, type QuizState } from '../src/comment/state.js'
import { findQuizComment } from '../src/github.js'
import { AUTHOR, BOT } from './support/fakes.js'

const state: QuizState = {
  v: 1,
  quizSha: 'abc1234',
  headSha: 'abc1234',
  diffHash: 'sha256:00',
  changedLines: 42,
  sourceFiles: ['src/a.ts'],
  questions: [{ id: 1, text: 'Why <b>this</b> & not --> that?', focus: 'design', files: [] }],
  status: 'pending',
  attempts: 0,
  refreshes: 0
}

describe('state marker', () => {
  it('round-trips through a hidden HTML comment', () => {
    const marker = encodeState(state)
    expect(marker.startsWith('<!-- ownership:state {')).toBe(true)
    expect(decodeState(`intro\n${marker}\nmore`)).toEqual(state)
  })

  it('cannot be closed early by the content it carries', () => {
    const marker = encodeState(state)
    const inner = marker.slice('<!-- '.length, -' -->'.length)
    expect(inner).not.toMatch(/[<>&]/)
    expect(inner).toContain('\\u003cb\\u003e')
  })

  it('rejects malformed or foreign markers', () => {
    expect(decodeState('<!-- ownership:state {"v":2} -->')).toBeUndefined()
    expect(decodeState('<!-- ownership:state {not json} -->')).toBeUndefined()
    expect(decodeState('no marker here')).toBeUndefined()
    expect(decodeState(undefined)).toBeUndefined()
  })

  it('only trusts markers written by a bot account', () => {
    const forged = {
      id: 1,
      body: encodeState({ ...state, attempts: 0 }),
      html_url: '',
      user: AUTHOR
    }
    const real = { id: 2, body: encodeState(state), html_url: '', user: BOT }
    expect(findQuizComment([forged])).toBeUndefined()
    expect(findQuizComment([forged, real])?.comment.id).toBe(2)
  })
})
