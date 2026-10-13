export interface ParsedAnswers {
  /** Answer text per question id; missing ids were not answered. */
  answers: Map<number, string>
  /** Text that could not be split into numbered answers; the model grades it against every question. */
  freeform?: string | undefined
  deadReckoning: boolean
  /** True when the comment contains nothing gradable. */
  empty: boolean
}

const COMMAND = /^\s*\/ownership(?=\s|$)/i
const DEAD_RECKONING = /^\s*(?:[-*+]\s*)?\[([ xX✓✔])\]\s*.*dead[\s-]*reckoning/i
const NUMBER_MARKER =
  /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:(?:q|question|answer|r|réponse|reponse)\s*)?(\d{1,2})\s*(?:\*\*|__)?\s*[.):\-–]\s*(?:\*\*|__)?/i
const FENCE = /^\s*(```|~~~)/
const PLACEHOLDERS = new Set(['your answer', 'ta réponse', 'ta reponse', '...', '…', 'todo', 'tbd'])

/** Whether a comment is an OwnerShip answer: its first line starts with "/ownership". */
export function isOwnershipCommand(body: string | undefined | null): boolean {
  return !!body && COMMAND.test(body)
}

/**
 * Parses "/ownership" replies. Numbered answers ("1.", "1)", "**1.**", "Q1:") are split per question;
 * quoted lines and code fences (from copying the template) are ignored, and the Dead Reckoning box is
 * read from its checkbox line.
 */
export function parseAnswers(body: string, questionIds: readonly number[]): ParsedAnswers {
  const lines = body.replace(/\r\n?/g, '\n').replace(COMMAND, '').split('\n')

  let deadReckoning = false
  const content: string[] = []
  for (const line of lines) {
    const box = DEAD_RECKONING.exec(line)
    if (box) {
      deadReckoning = deadReckoning || box[1] !== ' '
      continue
    }
    if (line.trimStart().startsWith('>') || FENCE.test(line)) continue
    content.push(line)
  }

  const answers = new Map<number, string>()
  const known = new Set(questionIds)
  let currentId: number | undefined
  let buffer: string[] = []
  const preamble: string[] = []
  const flush = (): void => {
    if (currentId !== undefined) answers.set(currentId, clean(buffer.join('\n')))
    buffer = []
  }

  for (const line of content) {
    const marker = NUMBER_MARKER.exec(line)
    const id = marker ? Number(marker[1]) : undefined
    // Only accept the next questions in increasing order, so numbered lists inside an answer stay put.
    if (id !== undefined && known.has(id) && (currentId === undefined || id > currentId)) {
      flush()
      currentId = id
      buffer.push(line.slice(marker![0].length))
    } else if (currentId === undefined) {
      preamble.push(line)
    } else {
      buffer.push(line)
    }
  }
  flush()

  for (const [id, text] of answers) {
    if (!text || PLACEHOLDERS.has(text.toLowerCase())) answers.delete(id)
  }

  let freeform: string | undefined
  const leftover = clean(preamble.join('\n'))
  if (answers.size === 0 && leftover) {
    if (questionIds.length === 1) answers.set(questionIds[0] as number, leftover)
    else freeform = leftover
  }

  return { answers, freeform, deadReckoning, empty: answers.size === 0 && !freeform }
}

function clean(text: string): string {
  return text.replace(/^\s*(?:\*\*|__)\s*/, '').trim()
}
