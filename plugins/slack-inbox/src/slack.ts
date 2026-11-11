// A minimal Slack Web API client. Read-only methods only: this tool never posts, reacts or edits.
import { type Me, passesRelay, type SlackMessage } from './match'

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

// Not needed by the listener; they let subscribe_conversation check membership and Slack Connect up front.
export const SUBSCRIBE_SCOPES = ['channels:read', 'groups:read', 'im:read', 'mpim:read']

// Slack only sends reaction_added and reaction_removed to an app with this scope.
export const REACTION_SCOPES = ['reactions:read']

export type Identity = {
  userId: string
  teamId: string
  enterpriseId?: string
  url: string
  missingScopes: string[]
  missingSubscribeScopes: string[]
  missingReactionScopes: string[]
}

export async function whoami(userToken: string): Promise<Identity> {
  const { body, scopes } = await api('auth.test', userToken)
  return {
    userId: body.user_id,
    teamId: body.team_id,
    enterpriseId: body.enterprise_id || undefined,
    url: body.url,
    missingScopes: REQUIRED_USER_SCOPES.filter(s => !scopes.includes(s)),
    missingSubscribeScopes: SUBSCRIBE_SCOPES.filter(s => !scopes.includes(s)),
    missingReactionScopes: REACTION_SCOPES.filter(s => !scopes.includes(s)),
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

// When the newest message in a conversation that the listener would receive was sent, in milliseconds, or 0 if none
// of the latest few is one. The relay drops bots off the allow-list, so a bot posting after the last event is no stall.
export async function newestMessageAt(userToken: string, channel: string, me: Me, allowBots: Set<string>): Promise<number> {
  const { body } = await api('conversations.history', userToken, { channel, limit: '20' })
  const m = (body.messages ?? []).find((m: SlackMessage) => passesRelay({ type: 'event_callback', event: { ...m, channel } }, me, allowBots))
  return m?.ts ? Number(m.ts) * 1000 : 0
}

type UserInfo = { name: string; botIds: string[] | null }
const users = new Map<string, UserInfo & { at: number }>()

// Display name, and for a bot user its bot and app ids (null for a person), cached for a day. A failed lookup gives
// the id as the name and counts as a person, so it is retried on the next call rather than cached.
export async function userInfo(userToken: string, id: string): Promise<UserInfo> {
  const hit = users.get(id)
  if (hit && Date.now() - hit.at < 86_400_000) return hit
  try {
    const u = (await api('users.info', userToken, { user: id })).body.user
    const name = u?.profile?.display_name || u?.real_name || u?.name || id
    const bot = u?.is_bot || id === 'USLACKBOT'
    const info = { name, botIds: bot ? ([u?.profile?.bot_id, u?.profile?.api_app_id].filter(Boolean) as string[]) : null }
    users.set(id, { ...info, at: Date.now() })
    return info
  } catch {
    return { name: id, botIds: null }
  }
}

export const userName = async (userToken: string, id: string) => (await userInfo(userToken, id)).name

// The thread a message is in: its thread_ts (its own ts if it starts one), or null if it is in none. conversations.replies
// takes any message of a thread and returns the parent first.
export async function itemThread(userToken: string, channel: string, ts: string): Promise<string | null> {
  const { body } = await api('conversations.replies', userToken, { channel, ts, limit: '1' })
  return body.messages?.[0]?.thread_ts ?? null
}

// A fresh Socket Mode WebSocket URL. Each URL works once.
export async function socketUrl(appToken: string): Promise<string> {
  return (await api('apps.connections.open', appToken)).body.url
}

export type ConversationCheck = { ok: true; name: string; note?: string } | { ok: false; reason: string }

// Whether the listener can see this conversation: the user must be a member (Slack only sends user events for
// those), and it must not be Slack Connect (the listener drops those). Without a token or the read scope it can't
// tell, and says so rather than refusing.
export async function checkConversation(userToken: string | undefined, id: string): Promise<ConversationCheck> {
  const unverified = (why: string): ConversationCheck => ({ ok: true, name: id, note: `not verified (${why}); events arrive only if you are a member and it is not Slack Connect` })
  if (!userToken) return unverified('no user token found')
  let c: Record<string, any>
  try {
    c = (await api('conversations.info', userToken, { channel: id })).body.channel ?? {}
  } catch (e) {
    const code = e instanceof SlackError ? e.code : (e as Error).message
    if (code === 'channel_not_found') return { ok: false, reason: `${id} was not found, or you can't see it` }
    if (code === 'missing_scope') return unverified(`the user token lacks ${id.startsWith('D') ? 'im:read' : 'channels:read, groups:read or mpim:read'}`)
    return unverified(`conversations.info failed: ${code}`)
  }
  const name = c.is_im ? `DM ${id}` : c.name ? `${c.is_mpim ? '' : '#'}${c.name}` : id
  if (c.is_ext_shared || c.is_pending_ext_shared) return { ok: false, reason: `${name} is a Slack Connect conversation; the listener never logs those` }
  if (c.is_archived) return { ok: false, reason: `${name} is archived` }
  if (!c.is_im && !c.is_mpim && c.is_member === false) return { ok: false, reason: `you are not a member of ${name}; join it in Slack first, as the listener only sees conversations you are in` }
  return { ok: true, name }
}
