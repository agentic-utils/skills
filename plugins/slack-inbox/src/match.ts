// Decides whether one Socket Mode event is something the user should hear about. Pure: no network, no clock.

export type Trigger = 'own' | 'dm' | 'group_dm' | 'mention' | 'group_mention' | 'thread_reply' | 'watched_thread' | 'watched_conversation'

// Highest first: the record's `trigger` is the first of these that matched.
// The watched_* ones come from a session's subscription, not from the message being addressed to the user.
// `own` is the user's own message, logged because the listener was asked for all of them; it never comes with the
// personal ones, so putting it first only makes it the `trigger` of every own record.
export const PRIORITY: Trigger[] = ['own', 'dm', 'group_dm', 'mention', 'group_mention', 'thread_reply', 'watched_thread', 'watched_conversation']

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

// reaction_added / reaction_removed. Slack gives the reacting user, the emoji and the item, never the item's thread.
export type SlackReaction = {
  type: 'reaction_added' | 'reaction_removed'
  user: string
  reaction: string
  item_user?: string // who posted the item
  item: { type: string; channel?: string; ts?: string }
  event_ts: string
}

export type EventsApiPayload = {
  type: string
  event_id?: string
  team_id?: string
  enterprise_id?: string | null
  is_ext_shared_channel?: boolean
  event?: SlackMessage // or a reaction event, which screenReaction reads
}

export const REACTION_EVENTS: ReadonlySet<string> = new Set(['reaction_added', 'reaction_removed'])

// Subtypes that are a person (or an allowed bot) saying something new. Edits, deletes, joins and the rest are skipped.
const SPOKEN = new Set([undefined, 'thread_broadcast', 'file_share', 'me_message', 'bot_message'])

export type Screened =
  | { skip: 'not_message' | 'subtype' | 'bot' }
  | { skip: 'own'; thread?: string; external: boolean } // `thread`: a thread the user just took part in
  | { message: SlackMessage; external: boolean }

export const threadKey = (channel: string, threadTs: string) => `${channel}:${threadTs}`

export const isThreadReply = (m: SlackMessage) => !!m.thread_ts && m.thread_ts !== m.ts

// Drops what is never reported, whatever its text: the user's own messages, and bots not on the allow-list. Slack
// Connect is kept but flagged `external`, and the caller lets only personal (or own) triggers through for it.
export function screen(payload: EventsApiPayload, me: Me, allowBots: Set<string>): Screened {
  const m = payload.event
  if (payload.type !== 'event_callback' || !m || m.type !== 'message') return { skip: 'not_message' }
  if (!SPOKEN.has(m.subtype)) return { skip: 'subtype' }
  // Outside an Enterprise Grid org a user from another team can only be external. Inside one, other teams are
  // colleagues, and a shared channel with another org is still flagged by is_ext_shared_channel.
  const external = !!payload.is_ext_shared_channel || (!!m.user_team && m.user_team !== me.teamId && !me.enterpriseId)
  if (m.user === me.userId) return { skip: 'own', thread: m.thread_ts ? threadKey(m.channel, m.thread_ts) : undefined, external }
  const isBot = !!m.bot_id || m.subtype === 'bot_message' || m.user === 'USLACKBOT'
  if (isBot) {
    const ids = [m.bot_id, m.app_id, m.bot_profile?.app_id, m.user].filter(Boolean) as string[]
    if (!ids.some(id => allowBots.has(id))) return { skip: 'bot' }
  }
  return { message: m, external }
}

export type ScreenedReaction = { skip: 'not_reaction' | 'not_message_item' } | { reaction: SlackReaction; own: boolean; external: boolean }

// The reaction counterpart of screen. Reactions on files and file comments are skipped: there is no message to point
// at. A reaction event says nothing about whether the reactor is a bot, so that is botBlocked's job, with a lookup.
export function screenReaction(payload: EventsApiPayload, me: Me): ScreenedReaction {
  const r = payload.event as unknown as SlackReaction | undefined
  if (payload.type !== 'event_callback' || !r || !REACTION_EVENTS.has(r.type) || typeof r.user !== 'string' || typeof r.reaction !== 'string')
    return { skip: 'not_reaction' }
  if (r.item?.type !== 'message' || typeof r.item.channel !== 'string' || typeof r.item.ts !== 'string') return { skip: 'not_message_item' }
  return { reaction: r, own: r.user === me.userId, external: !!payload.is_ext_shared_channel }
}

// The allow_bots rule for a reacting user. `botIds`: the bot's ids (user, bot and app id) from users.info, or null
// for a person.
export const botBlocked = (user: string, botIds: string[] | null, allowBots: Set<string>) =>
  !!botIds && ![user, ...botIds].some(id => allowBots.has(id))

// Whether the relay stores an event: only what screen keeps, plus the user's own messages, and reactions to messages.
// Everything else would be dropped by the listener and replay anyway, and on a busy workspace bots are most of the
// traffic and of D1's writes. The relay can't tell a reacting bot from a person, so the listener drops those.
export const passesRelay = (payload: EventsApiPayload, me: Me, allowBots: Set<string>) => {
  if (payload.event && REACTION_EVENTS.has(payload.event.type)) return !('skip' in screenReaction(payload, me))
  const s = screen(payload, me, allowBots)
  return !('skip' in s) || s.skip === 'own'
}

// What a reaction is logged for. `on_own_message`: someone reacted to the user's message (personal, so the inbox).
// `own`: the user reacted, logged only where asked for. `threadTs`: the item's thread, when known (the item's own ts
// if it starts one); a reaction to a watched thread's parent counts for that thread.
export type ReactionTrigger = 'own' | 'on_own_message' | 'watched_thread' | 'watched_conversation'
export const REACTION_PRIORITY: ReactionTrigger[] = ['own', 'on_own_message', 'watched_thread', 'watched_conversation']

export function reactionTriggers(r: SlackReaction, me: Me, watches: Map<string, boolean>, own: boolean, logOwn: boolean, threadTs?: string): ReactionTrigger[] {
  const channel = r.item.channel!
  const ts = r.item.ts!
  const out: ReactionTrigger[] = []
  const wants = (k: string) => watches.has(k) && (!own || watches.get(k) === true)
  if (own && logOwn) out.push('own')
  if (!own && r.item_user === me.userId) out.push('on_own_message')
  if (wants(threadKey(channel, ts)) || (threadTs && wants(threadKey(channel, threadTs)))) out.push('watched_thread')
  if (wants(channel)) out.push('watched_conversation')
  return out
}

// Whether matching a reaction needs its item's thread: only when some session watches a thread in that conversation
// and the item isn't that thread's parent.
export const needsItemThread = (r: SlackReaction, watches: Map<string, boolean>) => {
  const prefix = `${r.item.channel}:`
  for (const k of watches.keys()) if (k.startsWith(prefix) && k !== `${prefix}${r.item.ts}`) return true
  return false
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

// What may be logged from a Slack Connect conversation: only what is addressed to the user, or is their own post,
// never a session's watch of it.
export const PERSONAL: ReadonlySet<Trigger> = new Set(['own', 'dm', 'group_dm', 'mention', 'group_mention', 'thread_reply'])

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

// The attribution line a Claude session ends a Slack post with when it posts as the user: `_✨ via <url|Claude session>_`.
const VIA_CLAUDE = /_✨ via <[^>|]+\|Claude session>_\s*$/u
export const viaClaude = (text: string | undefined) => VIA_CLAUDE.test(text ?? '')

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
