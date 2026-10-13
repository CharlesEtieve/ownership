import * as github from '@actions/github'
import type { LabelSpec } from './badges.js'
import { decodeState, type QuizState } from './comment/state.js'
import type { PrFile } from './diff/filter.js'

export interface IssueComment {
  id: number
  body: string
  html_url: string
  user: { login: string; type: string } | null
}

export interface PullRequestInfo {
  number: number
  title: string
  body: string
  draft: boolean
  headSha: string
  author: { login: string; type: string }
  isFork: boolean
}

export type Reaction = 'eyes' | 'rocket' | 'confused' | 'hooray' | '+1'
export type StatusState = 'pending' | 'success'

/** The few GitHub operations OwnerShip needs, behind an interface so handlers are easy to test. */
export interface GitHubApi {
  getPullRequest(number: number): Promise<PullRequestInfo>
  listFiles(number: number): Promise<PrFile[]>
  listComments(number: number): Promise<IssueComment[]>
  createComment(number: number, body: string): Promise<IssueComment>
  updateComment(id: number, body: string): Promise<void>
  addReaction(commentId: number, reaction: Reaction): Promise<void>
  /** Adds labels, creating them with their colour and description when they don't exist yet. */
  addLabels(number: number, labels: readonly LabelSpec[]): Promise<void>
  removeLabels(number: number, names: readonly string[]): Promise<void>
  setStatus(sha: string, state: StatusState, description: string, targetUrl?: string): Promise<void>
}

export const STATUS_CONTEXT = 'OwnerShip'

export function createGitHubApi(token: string, owner: string, repo: string): GitHubApi {
  const octokit = github.getOctokit(token)
  const rest = octokit.rest

  return {
    async getPullRequest(number) {
      const { data } = await rest.pulls.get({ owner, repo, pull_number: number })
      return {
        number: data.number,
        title: data.title,
        body: data.body ?? '',
        draft: data.draft ?? false,
        headSha: data.head.sha,
        author: { login: data.user.login, type: data.user.type },
        isFork: data.head.repo?.full_name !== data.base.repo.full_name
      }
    },

    async listFiles(number) {
      const files = await octokit.paginate(rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: number,
        per_page: 100
      })
      return files.map(file => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: file.patch,
        previous_filename: file.previous_filename
      }))
    },

    async listComments(number) {
      const comments = await octokit.paginate(rest.issues.listComments, {
        owner,
        repo,
        issue_number: number,
        per_page: 100
      })
      return comments.map(toComment)
    },

    async createComment(number, body) {
      const { data } = await rest.issues.createComment({ owner, repo, issue_number: number, body })
      return toComment(data)
    },

    async updateComment(id, body) {
      await rest.issues.updateComment({ owner, repo, comment_id: id, body })
    },

    async addReaction(commentId, reaction) {
      await rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: commentId,
        content: reaction
      })
    },

    async addLabels(number, labels) {
      for (const label of labels) {
        try {
          await rest.issues.getLabel({ owner, repo, name: label.name })
        } catch (error) {
          if (statusOf(error) !== 404) throw error
          try {
            await rest.issues.createLabel({ owner, repo, ...label })
          } catch (createError) {
            // 422: created concurrently by another run.
            if (statusOf(createError) !== 422) throw createError
          }
        }
      }
      await rest.issues.addLabels({
        owner,
        repo,
        issue_number: number,
        labels: labels.map(label => label.name)
      })
    },

    async removeLabels(number, names) {
      for (const name of names) {
        try {
          await rest.issues.removeLabel({ owner, repo, issue_number: number, name })
        } catch (error) {
          if (statusOf(error) !== 404) throw error
        }
      }
    },

    async setStatus(sha, state, description, targetUrl) {
      await rest.repos.createCommitStatus({
        owner,
        repo,
        sha,
        state,
        context: STATUS_CONTEXT,
        description: description.slice(0, 140),
        ...(targetUrl ? { target_url: targetUrl } : {})
      })
    }
  }
}

function toComment(data: {
  id: number
  body?: string | undefined
  html_url: string
  user: { login: string; type: string } | null
}): IssueComment {
  return {
    id: data.id,
    body: data.body ?? '',
    html_url: data.html_url,
    user: data.user ? { login: data.user.login, type: data.user.type } : null
  }
}

export function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status
    return typeof status === 'number' ? status : undefined
  }
  return undefined
}

export function isBotAccount(user: { login: string; type: string } | null | undefined): boolean {
  return !!user && (user.type === 'Bot' || user.login.endsWith('[bot]'))
}

export interface QuizComment {
  comment: IssueComment
  state: QuizState
}

/**
 * Finds the quiz comment. Only comments written by a bot account (the action's token) are trusted,
 * so nobody can forge a state marker in a regular comment.
 */
export function findQuizComment(comments: readonly IssueComment[]): QuizComment | undefined {
  for (const comment of comments) {
    if (!isBotAccount(comment.user)) continue
    const state = decodeState(comment.body)
    if (state) return { comment, state }
  }
  return undefined
}
