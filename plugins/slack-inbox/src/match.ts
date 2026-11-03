// Decides whether one Socket Mode event is something the user should hear about. Pure: no network, no clock.

export type Trigger = 'dm' | 'group_dm' | 'mention' | 'group_mention' | 'thread_reply' | 'watched_thread' | 'watched_conversation'

// Highest first: the record's `trigger` is the first of these that matched.
// The watched_* ones come from a session's subscription, not from the message being addressed to the user.
export const PRIORITY: Trigger[] = ['dm', 'group_dm', 'mention', 'group_mention', 'thread_reply', 'watched_thread', 'watched_conversation']

export type Me = { userId: string; teamId: string; enterpriseId?: string }

export type SlackMessage = {
  type: string
  subtype?: string
  channel: string
  channel_type?: string
  user?: string
  user_team?: string
  bot_id?: string
  app_id?: string
  bot_profile?: { app_id?: string }
  text?: string
  ts: string
  thread_ts?: string
  parent_user_id?: string
}

export type EventsApiPayload = {
  type: string
  event_id?: string
  team_id?: string
  enterprise_id?: string | null
  is_ext_shared_channel?: boolean
  event?: SlackMessage
}

// Subtypes that are a person (or an allowed bot) saying something new. Edits, deletes, joins and the rest are skipped.
const SPOKEN = new Set([undefined, 'thread_broadcast', 'file_share', 'me_message', 'bot_message'])

export type Screened =
  | { skip: 'not_message' | 'subtype' | 'external' | 'bot' }
  | { skip: 'own'; thread?: string } // `thread`: a thread the user just took part in
  | { message: SlackMessage }

export const threadKey = (channel: string, threadTs: string) => `${channel}:${threadTs}`

export const isThreadReply = (m: SlackMessage) => !!m.thread_ts && m.thread_ts !== m.ts

// Drops what is never reported, whatever its text: the user's own messages, bots not on the allow-list, Slack Connect.
export function screen(payload: EventsApiPayload, me: Me, allowBots: Set<string>): Screened {
  const m = payload.event
  if (payload.type !== 'event_callback' || !m || m.type !== 'message') return { skip: 'not_message' }
  if (!SPOKEN.has(m.subtype)) return { skip: 'subtype' }
  if (payload.is_ext_shared_channel) return { skip: 'external' }
  // Outside an Enterprise Grid org a user from another team can only be external. Inside one, other teams are
  // colleagues, and a shared channel with another org is still flagged by is_ext_shared_channel above.
  if (m.user_team && m.user_team !== me.teamId && !me.enterpriseId) return { skip: 'external' }
  if (m.user === me.userId) return { skip: 'own', thread: m.thread_ts ? threadKey(m.channel, m.thread_ts) : undefined }
  const isBot = !!m.bot_id || m.subtype === 'bot_message' || m.user === 'USLACKBOT'
  if (isBot) {
    const ids = [m.bot_id, m.app_id, m.bot_profile?.app_id, m.user].filter(Boolean) as string[]
    if (!ids.some(id => allowBots.has(id))) return { skip: 'bot' }
  }
  return { message: m }
}

const SUBTEAM = /<!subteam\^([A-Z0-9]+)/g

// Every trigger the message hits. `inThread` says whether the user started or replied in the message's thread; the
// caller looks that up only when needsThreadLookup says it matters. `watches` holds the conversations and threads
// some session subscribed to (keys as subKey makes them).
export function triggers(m: SlackMessage, me: Me, groups: Set<string>, inThread: boolean, watches: Map<string, boolean> = new Map()): Trigger[] {
  const out: Trigger[] = []
  if (m.channel_type === 'im') out.push('dm')
  if (m.channel_type === 'mpim') out.push('group_dm')
  const text = m.text ?? ''
  if (new RegExp(`<@${me.userId}(\\|[^>]*)?>`).test(text)) out.push('mention')
  for (const [, id] of text.matchAll(SUBTEAM))
    if (groups.has(id)) {
      out.push('group_mention')
      break
    }
  if (isThreadReply(m) && (m.parent_user_id === me.userId || inThread)) out.push('thread_reply')
  return [...out, ...watched(m, watches, false)]
}

// The watched_* triggers alone. `own`: the message is the user's, logged only where a session asked for those.
export function watched(m: SlackMessage, watches: Map<string, boolean>, own: boolean): Trigger[] {
  const out: Trigger[] = []
  const wants = (k: string) => watches.has(k) && (!own || watches.get(k) === true)
  if (isThreadReply(m) && wants(threadKey(m.channel, m.thread_ts!))) out.push('watched_thread')
  if (wants(m.channel)) out.push('watched_conversation')
  return out
}

// A thread reply needs a lookup only when nothing cheaper already says whether the user is in that thread.
export const needsThreadLookup = (m: SlackMessage, me: Me) => isThreadReply(m) && m.parent_user_id !== me.userId

// Whitespace collapsed and control characters dropped, so a preview is always one line of the JSONL file.
export function preview(text: string | undefined, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const flat = (text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// Built from the workspace URL auth.test returns, so no API call per message.
export function permalink(teamUrl: string, m: SlackMessage): string {
  const base = `${teamUrl.replace(/\/?$/, '/')}archives/${m.channel}/p${m.ts.replace('.', '')}`
  return isThreadReply(m) ? `${base}?thread_ts=${m.thread_ts}&cid=${m.channel}` : base
}
