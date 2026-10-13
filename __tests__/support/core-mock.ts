import { vi } from 'vitest'

// Stand-in for @actions/core: silent, and observable from tests.
export const info = vi.fn()
export const debug = vi.fn()
export const notice = vi.fn()
export const warning = vi.fn()
export const error = vi.fn()
export const setFailed = vi.fn()
export const setOutput = vi.fn()
export const setSecret = vi.fn()
export const getInput = vi.fn((_name: string) => '')

const summaryChunks: string[] = []
export const summary = {
  chunks: summaryChunks,
  addRaw: vi.fn((text: string) => {
    summaryChunks.push(text)
    return summary
  }),
  write: vi.fn(async () => summary)
}
