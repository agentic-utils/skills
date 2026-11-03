// A minimal Slack Web API client. Read-only methods only: this tool never posts, reacts or edits.

export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`${method}: ${code}`)
  }
}

export type ApiResult = Record<string, any> & { ok: boolean; error?: string }

// Waits out a 429 (up to three times) instead of failing, since every caller here can afford to be late.
export async function api(method: string, token: string, params: Record<string, string> = {}): Promise<{ body: ApiResult; scopes: string[] }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status === 429 && attempt < 3) {
      await Bun.sleep(Number(res.headers.get('retry-after') ?? 5) * 1000)
      continue
    }
    const body = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as ApiResult
    if (!body.ok) throw new SlackError(method, body.error ?? `http_${res.status}`)
    const scopes = (res.headers.get('x-oauth-scopes') ?? '').split(',').map(s => s.trim()).filter(Boolean)
    return { body, scopes }
  }
}

export const REQUIRED_USER_SCOPES = ['channels:history', 'groups:history', 'im:history', 'mpim:history', 'usergroups:read', 'users:read']

export type Identity = { userId: string; teamId: string; enterpriseId?: string; url: string; missingScopes: string[] }

export async function whoami(userToken: string): Promise<Identity> {
  const { body, scopes } = await api('auth.test', userToken)
  return {
    userId: body.user_id,
    teamId: body.team_id,
    enterpriseId: body.enterprise_id || undefined,
    url: body.url,
    missingScopes: REQUIRED_USER_SCOPES.filter(s => !scopes.includes(s)),
  }
}

// The ids of every enabled user group the user is in, so `<!subteam^ID>` in a message can be matched locally.
export async function myGroups(userToken: string, userId: string): Promise<Set<string>> {
  const { body } = await api('usergroups.list', userToken, { include_users: 'true' })
  const out = new Set<string>()
  for (const g of body.usergroups ?? []) {
    let users: string[] | undefined = g.users
    if (!users) users = (await api('usergroups.users.list', userToken, { usergroup: g.id })).body.users ?? []
    if (users!.includes(userId)) out.add(g.id)
  }
  return out
}

// Whether the user started the thread or has replied in it, from the parent's reply_users (paging only if that list
// is incomplete).
export async function inThread(userToken: string, userId: string, channel: string, threadTs: string): Promise<boolean> {
  let cursor = ''
  for (let page = 0; page < 10; page++) {
    const { body } = await api('conversations.replies', userToken, { channel, ts: threadTs, limit: '200', ...(cursor ? { cursor } : {}) })
    const msgs: { user?: string; ts: string; reply_users?: string[]; reply_users_count?: number }[] = body.messages ?? []
    if (msgs.some(m => m.user === userId)) return true
    const parent = msgs.find(m => m.ts === threadTs)
    if (page === 0 && parent?.reply_users && parent.reply_users.length >= (parent.reply_users_count ?? 0)) return parent.reply_users.includes(userId)
    cursor = body.response_metadata?.next_cursor ?? ''
    if (!cursor) return false
  }
  return false
}

const names = new Map<string, { name: string; at: number }>()

// Display name for the record, cached for a day; falls back to the id if the lookup fails.
export async function userName(userToken: string, id: string): Promise<string> {
  const hit = names.get(id)
  if (hit && Date.now() - hit.at < 86_400_000) return hit.name
  try {
    const u = (await api('users.info', userToken, { user: id })).body.user
    const name = u?.profile?.display_name || u?.real_name || u?.name || id
    names.set(id, { name, at: Date.now() })
    return name
  } catch {
    return id
  }
}

// A fresh Socket Mode WebSocket URL. Each URL works once.
export async function socketUrl(appToken: string): Promise<string> {
  return (await api('apps.connections.open', appToken)).body.url
}
