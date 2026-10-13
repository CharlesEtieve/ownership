import { describe, expect, it } from 'vitest'
import { SchemaError, validateEvaluation, validateQuiz } from '../src/llm/schemas.js'

describe('validateQuiz', () => {
  it('accepts a valid quiz, normalises focus and keeps at most 3 files', () => {
    const quiz = validateQuiz(
      {
        questions: [
          { question: ' Why? ', focus: 'Edge case', files: ['a', 'b', 'c', 'd'] },
          { question: 'What if it fails?', focus: 'error-handling', files: [] }
        ]
      },
      2
    )
    expect(quiz.questions[0]).toEqual({
      question: 'Why?',
      focus: 'edge-cases',
      files: ['a', 'b', 'c']
    })
    expect(quiz.questions[1]?.focus).toBe('error-handling')
  })

  it('drops extra questions but rejects missing ones', () => {
    const three = {
      questions: [1, 2, 3].map(i => ({ question: `Q${i}`, focus: 'design', files: [] }))
    }
    expect(validateQuiz(three, 2).questions).toHaveLength(2)
    expect(() => validateQuiz(three, 4)).toThrow(SchemaError)
  })

  it('explains what is wrong', () => {
    expect(() => validateQuiz({ questions: [{ question: 1 }] }, 1)).toThrow(
      '$.questions[0].question must be a string'
    )
    expect(() => validateQuiz([], 1)).toThrow('$ must be an object')
  })
})

describe('validateEvaluation', () => {
  const entry = (id: number | string, grade = 'solid') => ({
    id,
    grade,
    feedback: 'f',
    explanation: 'e'
  })

  it('orders evaluations by question id', () => {
    const result = validateEvaluation(
      { evaluations: [entry(2, 'partial'), entry(1)], summary: ' ok ' },
      [1, 2]
    )
    expect(result.evaluations.map(e => [e.id, e.grade])).toEqual([
      [1, 'solid'],
      [2, 'partial']
    ])
    expect(result.summary).toBe('ok')
  })

  it('accepts string ids and upper-case grades', () => {
    expect(
      validateEvaluation({ evaluations: [entry('1', 'SOLID')], summary: '' }, [1]).evaluations[0]
        ?.grade
    ).toBe('solid')
  })

  it('rejects unknown grades and missing questions', () => {
    expect(() =>
      validateEvaluation({ evaluations: [entry(1, 'great')], summary: '' }, [1])
    ).toThrow('grade must be one of')
    expect(() => validateEvaluation({ evaluations: [entry(1)], summary: '' }, [1, 2])).toThrow(
      'missing evaluations for question id(s) 2'
    )
  })
})
