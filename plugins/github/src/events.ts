// What reaches Claude: GitHub webhook payloads turned into one-line summaries, and the PR argument parser.
import { createHmac, timingSafeEqual } from 'node:crypto'

const clip = (s: string | null | undefined, n = 1500) => ((s ?? '').length > n ? s!.slice(0, n) + ' [truncated]' : (s ?? ''))

export type Event = { pr: number; text: string; done?: boolean } | null


// Heartbeat file name for a PR: owner_repo_n, the same as `sed 's#https://github.com/##; s#/pull/#_#; s#/#_#g'` on its URL.
export const beatName = (pr: string) => pr.replace('#', '_').replace('/', '_')

// Accepts https://github.com/o/r/pull/n or o/r#n.
export function parsePr(s: string): string | null {
  const m = s.trim().match(/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:\/pull\/|#)(\d+)/)
  return m ? `${m[1]}#${m[2]}` : null
}

// Returns null for anything not worth waking Claude for.
export function summarise(event: string, p: any): Event {
  const repo = p.repository?.full_name
  const by = p.sender?.login
  switch (event) {
    case 'pull_request': {
      const url = p.pull_request.html_url
      const pr = p.number
      const reviewer = p.requested_reviewer?.login ?? p.requested_team?.name
      // what each action reads as; anything not listed (edited, assigned, locked, ...) is dropped
      const said: Record<string, string> = {
        opened: `PR opened by ${by}: ${p.pull_request.title}`,
        reopened: `PR reopened by ${by}`,
        closed: p.pull_request.merged ? `PR merged by ${by}` : `PR closed without merging by ${by}`,
        ready_for_review: `PR marked ready for review by ${by}`,
        converted_to_draft: `PR converted to draft by ${by}`,
        review_requested: `Review requested from ${reviewer} by ${by}`,
        review_request_removed: `Review request for ${reviewer} withdrawn by ${by}`,
        labeled: `Label "${p.label?.name}" added by ${by}`,
        unlabeled: `Label "${p.label?.name}" removed by ${by}`,
        auto_merge_enabled: `Auto-merge enabled by ${by}`,
        auto_merge_disabled: `Auto-merge disabled by ${by}${p.reason ? `: ${p.reason}` : ''}`,
        enqueued: 'Added to the merge queue',
        dequeued: `Removed from the merge queue${p.reason ? `: ${p.reason}` : ''}`,
        // a force push is spotted later (needs an API call) and reworded there
        synchronize: `New commits pushed by ${by}: ${p.before?.slice(0, 7)}..${p.after?.slice(0, 7)}`,
      }
      if (!(p.action in said)) return null
      return { pr, done: p.action === 'closed', text: `${said[p.action]}\n${url}` }
    }
    case 'pull_request_review': {
      const r = p.review
      if (p.action === 'dismissed')
        return { pr: p.pull_request.number, text: `Review by ${r.user?.login} dismissed by ${by}\n${r.html_url}` }
      // replying in a review thread creates an empty COMMENTED review; the comment itself arrives separately
      if (p.action !== 'submitted' || (r.state === 'commented' && !r.body)) return null
      return {
        pr: p.pull_request.number,
        text: `Review ${r.state} by ${by}\n${r.html_url}\n${clip(r.body)}`,
      }
    }
    case 'pull_request_review_thread': {
      if (!['resolved', 'unresolved'].includes(p.action)) return null
      const c = p.thread?.comments?.[0]
      return {
        pr: p.pull_request.number,
        text: `Review thread on ${c?.path}:${c?.line ?? c?.original_line} ${p.action === 'resolved' ? 'resolved' : 'reopened'} by ${by}\n${c?.html_url}`,
      }
    }
    case 'pull_request_review_comment': {
      if (p.action !== 'created') return null
      const c = p.comment
      return {
        pr: p.pull_request.number,
        text: `Review comment by ${by} on ${c.path}:${c.line ?? c.original_line}\n${c.html_url}\n${clip(c.body)}`,
      }
    }
    case 'issue_comment': {
      if (p.action !== 'created' || !p.issue.pull_request) return null
      return { pr: p.issue.number, text: `Comment by ${by}\n${p.comment.html_url}\n${clip(p.comment.body)}` }
    }
    case 'check_suite': {
      // one per app per push; skip non-signal conclusions
      const s = p.check_suite
      if (p.action !== 'completed' || ['neutral', 'skipped', 'stale', 'cancelled'].includes(s.conclusion)) return null
      if (s.app?.slug === 'github-actions') return null // workflow_run reports these per workflow
      const pr = s.pull_requests?.[0]?.number
      if (!pr) return null
      return {
        pr,
        text: `Checks ${s.conclusion} (${s.app?.name}) on ${s.head_sha.slice(0, 7)}\nhttps://github.com/${repo}/pull/${pr}/checks`,
      }
    }
    case 'workflow_run': {
      // one per workflow per push; pull_requests is empty for runs from forks
      const w = p.workflow_run
      if (p.action !== 'completed' || ['neutral', 'skipped', 'stale', 'cancelled'].includes(w.conclusion)) return null
      const pr = w.pull_requests?.[0]?.number
      if (!pr) return null
      return { pr, text: `Workflow ${w.name} ${w.conclusion} on ${w.head_sha.slice(0, 7)}\n${w.html_url}` }
    }
  }
  return null
}

export function verified(body: string, sig: string | null, secret: string): boolean {
  const want = Buffer.from('sha256=' + createHmac('sha256', secret).update(body).digest('hex'))
  const got = Buffer.from(sig ?? '')
  return got.length === want.length && timingSafeEqual(got, want)
}
