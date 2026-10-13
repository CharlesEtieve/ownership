# Contributing to OwnerShip

Thanks for wanting to help! OwnerShip is small on purpose, and contributions of every size are welcome: bug reports, ideas, docs, translations and code.

## Principles

Every change should keep these true:

- **Never punitive.** No timers, no rankings, non-blocking by default.
- **Learn before judging.** Every answer, right or wrong, gets an explanation.
- **No server, no telemetry.** Everything lives in the repository and in GitHub.
- **Bring your own model.** No dependency on a single provider.
- **Light maritime flavour** in user-facing texts, without overdoing it.

## Getting started

You need Node.js 24 (see `.node-version`).

```bash
npm install
npm test           # Vitest, with the model and GitHub faked
npm run typecheck
npm run build      # bundles src/ into dist/index.js with Rollup
npm run all        # format check, typecheck, tests and build
```

**`dist/` is committed**, because GitHub runs the action straight from the repository. Run `npm run build` and commit `dist/` with your change; CI fails when it is out of date.

## Project layout

```
src/
  main.ts            routes the event to a handler, writes outputs and the job summary
  config.ts          reads and validates the action inputs
  handlers/quiz.ts   pull_request: filter the diff, generate questions, post or update the quiz
  handlers/answer.ts issue_comment: parse answers, evaluate them, debrief, labels, status
  diff/              file filtering (globs, generated code) and the diff budget
  llm/               providers (plain fetch), prompts, JSON schemas and validation
  comment/           the hidden state marker, comment rendering, answer parsing, i18n
  badges.ts          ranks and label definitions
  github.ts          the small GitHub API surface the handlers use
__tests__/           unit and scenario tests
__fixtures__/files/  sample "list pull request files" responses
```

## Tests

- Tests never call a real model or GitHub: use `FakeLlm` and `FakeGitHub` from `__tests__/support/fakes.ts`.
- New diff scenarios go in `__fixtures__/files/` as JSON, in the shape returned by the GitHub API.
- Behaviour changes need a test; prompt changes need a look at the prompt tests too.

## Common contributions

- **Translations:** add a `Messages` entry in `src/comment/i18n.ts` and a matching rule in `messagesFor`. Keep the tone warm and the "Dead Reckoning" words in the checkbox line, which the answer parser looks for.
- **Exclusions:** add noisy file patterns to `DEFAULT_EXCLUDES` in `src/diff/filter.ts`, with a test.
- **Providers:** most servers speak the OpenAI or Anthropic API and need no code. A truly new API goes in `src/llm/provider.ts`, behind the `LlmClient` interface, with request-shape tests using a fake `fetch`.

## Pull requests

- Keep PRs focused, and explain the _why_ in the description. (Yes, OwnerShip will quiz you on it. ⚓)
- Format with `npm run format`.
- Never log secrets or full diffs.

## Reporting security issues

Please do not open a public issue for vulnerabilities (for example a way to leak the API key or to forge quiz state). Use GitHub's private vulnerability reporting on this repository instead.
