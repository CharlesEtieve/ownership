import * as core from '@actions/core'
import * as github from '@actions/github'
import { OwnershipError, readConfig, requiresApiKey, type Config } from './config.js'
import { createGitHubApi, type GitHubApi } from './github.js'
import { handleIssueComment, type IssueCommentEvent } from './handlers/answer.js'
import { handlePullRequest, type PullRequestEvent } from './handlers/quiz.js'
import { skipped, type Deps, type Outcome } from './handlers/shared.js'
import { newNonce } from './llm/prompts.js'
import { createClient, type LlmClient } from './llm/provider.js'

export interface RunContext {
  eventName: string
  payload: unknown
  repo: { owner: string; repo: string }
}

export interface RunOverrides {
  context?: RunContext
  config?: Config
  gh?: GitHubApi
  llm?: LlmClient
}

/** Entry point: routes the event to the right handler and reports the outcome. */
export async function run(overrides: RunOverrides = {}): Promise<Outcome | undefined> {
  try {
    const config = overrides.config ?? readConfig()
    const context = overrides.context ?? {
      eventName: github.context.eventName,
      payload: github.context.payload,
      repo: github.context.repo
    }
    if (!overrides.gh && !config.githubToken) {
      throw new OwnershipError(
        '"github-token" is empty. Leave it unset to use the default GITHUB_TOKEN.'
      )
    }
    const gh =
      overrides.gh ?? createGitHubApi(config.githubToken, context.repo.owner, context.repo.repo)

    let client = overrides.llm
    const deps: Deps = {
      gh,
      config,
      nonce: newNonce,
      llm: () => {
        if (client) return client
        if (!config.apiKey && requiresApiKey(config.provider)) {
          throw new OwnershipError(
            `"api-key" is empty. Store your ${config.provider} key as a repository secret and pass it ` +
              'with `api-key: ${{ secrets.YOUR_SECRET }}`.'
          )
        }
        client = createClient(config)
        return client
      }
    }

    const outcome = await route(context, deps)
    core.setOutput('result', outcome.kind)
    core.setOutput('rank', outcome.rank ?? '')
    try {
      await core.summary.addRaw(outcome.summary).write()
    } catch (error) {
      core.debug(`Could not write the job summary: ${String(error)}`)
    }
    return outcome
  } catch (error) {
    if (error instanceof OwnershipError) {
      core.setFailed(error.message)
    } else {
      const message = error instanceof Error ? error.message : String(error)
      core.setFailed(`OwnerShip hit an unexpected error: ${message}`)
    }
    return undefined
  }
}

async function route(context: RunContext, deps: Deps): Promise<Outcome> {
  switch (context.eventName) {
    case 'pull_request':
      return handlePullRequest(context.payload as PullRequestEvent, deps)
    case 'issue_comment':
      return handleIssueComment(context.payload as IssueCommentEvent, deps)
    case 'pull_request_target':
      core.warning(
        'OwnerShip does not run on pull_request_target: use the pull_request and issue_comment events ' +
          '(see the README).'
      )
      return skipped('pull_request_target is not supported.')
    default:
      return skipped(
        `the "${context.eventName}" event is not handled (use pull_request and issue_comment).`
      )
  }
}
