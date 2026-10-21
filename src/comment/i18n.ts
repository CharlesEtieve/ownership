import type { Focus, Grade, QuizFormat, Rank } from './state.js'

/** Texts that depend on how the author answers: picking letters or writing. */
export interface FormatTexts {
  howToAnswer: string
  answerPlaceholder: string
  emptyAnswers: string
  grades: Record<Grade, string>
  rankRules: Record<Rank, string>
  score: (solid: number, total: number) => string
}

/** Fixed interface texts. Questions and feedback come from the model, in the configured language. */
export interface Messages {
  open: FormatTexts
  choice: FormatTexts
  quizTitle: string
  quizIntro: (author: string, count: number) => string
  focus: Record<Focus, string>
  howToAnswerTitle: string
  deadReckoningLine: string
  deadReckoningHint: string
  badgesTitle: string
  deadReckoningRule: string
  statusPending: string
  statusEvaluated: (rank: string, score: string, debriefUrl?: string) => string
  attemptsUsed: (used: number, max: number) => string
  staleNote: (quizSha: string, headSha: string) => string
  refreshedNote: (sha: string) => string
  footer: (model: string) => string
  debriefTitle: string
  debriefIntro: (author: string) => string
  strongAnswer: string
  rightOption: string
  yourPick: (option: string) => string
  noPick: string
  summaryTitle: string
  badgeEarned: (badge: string) => string
  previousBestStays: (badge: string) => string
  captainCheer: string
  deadReckoningThanks: string
  tryAgain: (left: number) => string
  lastAttempt: string
  outOfAttempts: (max: number, badge: string) => string
}

const en: Messages = {
  open: {
    howToAnswer:
      'Reply to this PR with a comment that starts with `/ownership`, one numbered answer per question. A few sentences each is plenty:',
    answerPlaceholder: 'your answer',
    emptyAnswers:
      'I could not find any answers after `/ownership`. Reply with `/ownership` followed by your numbered answers, for example:',
    grades: { solid: '🟢 Solid', partial: '🟡 Partial', missing: '⚪ Missing' },
    rankRules: {
      deckhand: 'you answered the quiz',
      navigator: 'no answer left missing',
      captain: 'every answer solid'
    },
    score: (solid, total) => `${solid}/${total} solid`
  },
  choice: {
    howToAnswer:
      'Reply to this PR with a comment that starts with `/ownership` and the letter you pick for each question. ' +
      'You can add a short reason after a letter if you like. The quick form `/ownership 1B 2A 3D` works too:',
    answerPlaceholder: '?',
    emptyAnswers:
      'I could not find any letters after `/ownership`. Reply with `/ownership` followed by your picks, for example:',
    grades: { solid: '🟢 Right', partial: '🟡 Close', missing: '⚪ Not quite' },
    rankRules: {
      deckhand: 'you answered the quiz',
      navigator: 'every answer right or close',
      captain: 'every answer right'
    },
    score: (solid, total) => `${solid}/${total} right`
  },
  quizTitle: '⚓ OwnerShip: you shipped it. But do you own it?',
  quizIntro: (author, count) =>
    `Hey @${author}! Before this PR sets sail, here ${count === 1 ? 'is one question' : `are ${count} questions`} about your changes. ` +
    'No timer, no leaderboard: just a friendly check that you own what you ship. Every answer, right or wrong, gets an explanation.',
  focus: {
    design: '🧭 Design',
    'edge-cases': '🪨 Edge cases',
    'error-handling': '🛟 Error handling',
    impact: '🌊 Impact',
    testing: '🔦 Testing',
    security: '🔐 Security',
    performance: '💨 Performance'
  },
  howToAnswerTitle: 'How to answer',
  deadReckoningLine: '⚓ Dead Reckoning: I answered without AI help',
  deadReckoningHint:
    'Change `[ ]` to `[x]` if you answered from your own understanding, without asking an AI. It is on your honour, and optional.',
  badgesTitle: 'Badges you can earn',
  deadReckoningRule: 'you answered without AI help (on honour)',
  statusPending: '⏳ **Status:** waiting for your answers.',
  statusEvaluated: (rank, score, url) =>
    `✅ **Status:** answered. Best result: **${rank}** (${score})` +
    (url ? `, see the [debrief](${url}).` : '.'),
  attemptsUsed: (used, max) => `Attempts used: ${used}/${max}.`,
  staleNote: (quizSha, headSha) =>
    `ℹ️ New commits were pushed after this quiz (\`${quizSha}\` → \`${headSha}\`). The questions stay as they are.`,
  refreshedNote: sha => `🔄 Questions refreshed after significant changes in \`${sha}\`.`,
  footer: model => `OwnerShip · not an exam, just practice · questions by \`${model}\``,
  debriefTitle: '⚓ OwnerShip debrief',
  debriefIntro: author => `Thanks for answering, @${author}! Here is how it went.`,
  strongAnswer: 'What a strong answer covers',
  rightOption: 'Right answer',
  yourPick: option => `You picked ${option}`,
  noPick: 'No option picked.',
  summaryTitle: 'In short',
  badgeEarned: badge => `🎖️ Badge earned: **${badge}**`,
  previousBestStays: badge =>
    `Your previous attempt went further, so **${badge}** stays your badge.`,
  captainCheer: 'Every answer solid. The ship is yours, Captain!',
  deadReckoningThanks: '🗺️ Dead Reckoning noted: thanks for navigating on your own.',
  tryAgain: left =>
    `Want to aim higher? Reply again with \`/ownership\` (${left} attempt${left === 1 ? '' : 's'} left).`,
  lastAttempt: 'That was your last attempt on this PR. Fair winds! ⛵',
  outOfAttempts: (max, badge) =>
    (max === 1
      ? 'You already answered this quiz, so your result stands'
      : `You have used all ${max} attempts on this quiz, so your best result stands`) +
    `: **${badge}**. Fair winds! ⛵`
}

const fr: Messages = {
  open: {
    howToAnswer:
      'Réponds sur cette PR avec un commentaire qui commence par `/ownership`, une réponse numérotée par question. Quelques phrases suffisent :',
    answerPlaceholder: 'ta réponse',
    emptyAnswers:
      'Je n’ai trouvé aucune réponse après `/ownership`. Réponds avec `/ownership` suivi de tes réponses numérotées, par exemple :',
    grades: { solid: '🟢 Solide', partial: '🟡 Partielle', missing: '⚪ Manquante' },
    rankRules: {
      deckhand: 'tu as répondu au quiz',
      navigator: 'aucune réponse manquante',
      captain: 'toutes les réponses solides'
    },
    score: (solid, total) => `${solid}/${total} solides`
  },
  choice: {
    howToAnswer:
      'Réponds sur cette PR avec un commentaire qui commence par `/ownership` et la lettre que tu choisis pour chaque question. ' +
      'Tu peux ajouter une courte justification après une lettre si tu veux. La forme rapide `/ownership 1B 2A 3D` marche aussi :',
    answerPlaceholder: '?',
    emptyAnswers:
      'Je n’ai trouvé aucune lettre après `/ownership`. Réponds avec `/ownership` suivi de tes choix, par exemple :',
    grades: { solid: '🟢 Juste', partial: '🟡 Presque', missing: '⚪ Pas tout à fait' },
    rankRules: {
      deckhand: 'tu as répondu au quiz',
      navigator: 'toutes les réponses justes ou presque',
      captain: 'toutes les réponses justes'
    },
    score: (solid, total) => `${solid}/${total} justes`
  },
  quizTitle: '⚓ OwnerShip : tu l’as livré. Mais est-ce que tu le maîtrises ?',
  quizIntro: (author, count) =>
    `Salut @${author} ! Avant que cette PR ne prenne la mer, voici ${count === 1 ? 'une question' : `${count} questions`} sur tes changements. ` +
    'Pas de chrono, pas de classement : juste une vérification bienveillante que tu maîtrises ce que tu livres. Chaque réponse, juste ou non, reçoit une explication.',
  focus: {
    design: '🧭 Conception',
    'edge-cases': '🪨 Cas limites',
    'error-handling': '🛟 Gestion des erreurs',
    impact: '🌊 Impact',
    testing: '🔦 Tests',
    security: '🔐 Sécurité',
    performance: '💨 Performance'
  },
  howToAnswerTitle: 'Comment répondre',
  deadReckoningLine: '⚓ Dead Reckoning : j’ai répondu sans aide d’une IA',
  deadReckoningHint:
    'Remplace `[ ]` par `[x]` si tu as répondu avec ta propre compréhension, sans demander à une IA. C’est sur l’honneur, et facultatif.',
  badgesTitle: 'Badges à gagner',
  deadReckoningRule: 'tu as répondu sans aide d’une IA (sur l’honneur)',
  statusPending: '⏳ **Statut :** en attente de tes réponses.',
  statusEvaluated: (rank, score, url) =>
    `✅ **Statut :** répondu. Meilleur résultat : **${rank}** (${score})` +
    (url ? `, voir le [débrief](${url}).` : '.'),
  attemptsUsed: (used, max) => `Essais utilisés : ${used}/${max}.`,
  staleNote: (quizSha, headSha) =>
    `ℹ️ De nouveaux commits ont été poussés après ce quiz (\`${quizSha}\` → \`${headSha}\`). Les questions restent les mêmes.`,
  refreshedNote: sha =>
    `🔄 Questions renouvelées après des changements importants dans \`${sha}\`.`,
  footer: model =>
    `OwnerShip · pas un examen, juste de l’entraînement · questions par \`${model}\``,
  debriefTitle: '⚓ Débrief OwnerShip',
  debriefIntro: author => `Merci pour tes réponses, @${author} ! Voici le débrief.`,
  strongAnswer: 'Ce que couvre une bonne réponse',
  rightOption: 'Bonne réponse',
  yourPick: option => `Tu as choisi ${option}`,
  noPick: 'Aucune option choisie.',
  summaryTitle: 'En bref',
  badgeEarned: badge => `🎖️ Badge obtenu : **${badge}**`,
  previousBestStays: badge =>
    `Ton essai précédent était allé plus loin : **${badge}** reste ton badge.`,
  captainCheer: 'Toutes les réponses sont solides. Le navire est à toi, Capitaine !',
  deadReckoningThanks: '🗺️ Dead Reckoning noté : merci d’avoir navigué par tes propres moyens.',
  tryAgain: left =>
    `Envie de viser plus haut ? Réponds à nouveau avec \`/ownership\` (${left} essai${left === 1 ? '' : 's'} restant${left === 1 ? '' : 's'}).`,
  lastAttempt: 'C’était ton dernier essai sur cette PR. Bon vent ! ⛵',
  outOfAttempts: (max, badge) =>
    (max === 1
      ? 'Tu as déjà répondu à ce quiz, ton résultat reste'
      : `Tu as utilisé tes ${max} essais sur ce quiz, ton meilleur résultat reste`) +
    ` : **${badge}**. Bon vent ! ⛵`
}

export function formatTexts(messages: Messages, format: QuizFormat): FormatTexts {
  return format === 'multiple-choice' ? messages.choice : messages.open
}

const CATALOG: Record<string, Messages> = { en, fr }

/** Picks interface texts for the configured language, falling back to English. */
export function messagesFor(language: string): Messages {
  const normalized = language.trim().toLowerCase()
  if (/^fr\b|^fr[-_]|^french$|^fran[cç]ais$/.test(normalized)) return CATALOG.fr as Messages
  return CATALOG.en as Messages
}

/** Human-readable language name for the prompt ("fr" → "French"); unknown values pass through. */
export function languageName(language: string): string {
  const value = language.trim()
  if (/^[a-z]{2,3}([-_][a-z0-9]{2,8})*$/i.test(value)) {
    try {
      const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(value.replace('_', '-'))
      if (name && name.toLowerCase() !== value.toLowerCase()) return name
    } catch {
      // Not a valid BCP 47 tag: use the raw value.
    }
  }
  return value || 'English'
}
