// Replays recent messages from the relay into a file of their own, in full. It never touches the live log, the
// listener's cursor or any session, so it can run beside the listener and repeat nothing to anyone.
import { appendFileSync, closeSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { botBlocked, type EventsApiPayload, type Me, permalink, preview, REACTION_EVENTS, type SlackMessage, type SlackReaction, screen, screenReaction } from './match'
import { createPuller, type Fetch, type RelayKeys } from './pull'
import { createHandler } from './run'

const FULL_TEXT = Number.MAX_SAFE_INTEGER

// "2d", "12h", or anything Date.parse reads.
export function parseWhen(value: string, now: number): number {
  const ago = value.match(/^(\d+)([dh])$/)
  if (ago) return now - Number(ago[1]) * (ago[2] === 'd' ? 86_400_000 : 3_600_000)
  const at = Date.parse(value)
  if (Number.isNaN(at)) throw new Error(`can't read the time ${value}: use 2d, 12h or a date`)
  return at
}

export type ReplayFilter = { since: number; until?: number; channel?: string; all: boolean }

// A reaction is placed by when it was made, and in its item's conversation.
export function inFilter(p: EventsApiPayload, f: ReplayFilter): boolean {
  const e = p.event
  const r = REACTION_EVENTS.has(e?.type ?? '') ? (e as unknown as SlackReaction) : undefined
  const ts = r ? r.event_ts : e?.ts
  const channel = r ? r.item?.channel : e?.channel
  if (!ts) return false
  const at = Number(ts) * 1000
  return at >= f.since && (f.until === undefined || at <= f.until) && (!f.channel || channel === f.channel)
}

export type ReplayDeps = {
  url: string
  keys: RelayKeys
  me: Me
  teamUrl: string
  allowBots: Set<string>
  groups: Set<string>
  userInThread: (channel: string, threadTs: string) => Promise<boolean>
  userName: (id: string) => Promise<string>
  botIds: (id: string) => Promise<string[] | null>
  filter: ReplayFilter
  outFile: string
  log: (msg: string) => void
  fetch?: Fetch
  now?: () => number
}

export type ReplayResult = { written: number; skipped: number; expired: number; error?: string }

export async function replay(d: ReplayDeps): Promise<ReplayResult> {
  closeSync(openSync(d.outFile, 'wx', 0o600)) // never over an earlier replay, and private from the start
  let written = 0
  const emit = (record: Record<string, unknown>) => {
    appendFileSync(d.outFile, `${JSON.stringify({ ...record, replayed: true })}\n`)
    written++
  }

  const matched = createHandler({
    me: d.me,
    teamUrl: d.teamUrl,
    allowBots: d.allowBots,
    previewChars: FULL_TEXT,
    groups: () => d.groups,
    userInThread: d.userInThread,
    remember: () => {},
    watches: () => new Map(),
    logOwn: () => false,
    userName: d.userName,
    botIds: d.botIds,
    itemThread: async () => null, // nothing is watched here, so it is never asked
    emit,
  })

  // Every message and reaction rather than only those addressed to the user. Slack Connect stays limited to what is
  // addressed to the user, as in the live log, so an unaddressed one is left out here too.
  const everything = async (p: EventsApiPayload) => {
    if (REACTION_EVENTS.has(p.event?.type ?? '')) {
      const s = screenReaction(p, d.me)
      if ('skip' in s) return
      if (s.external) return matched(p)
      const r = s.reaction
      if (!s.own && botBlocked(r.user, await d.botIds(r.user), d.allowBots)) return
      return emit({
        kind: 'reaction',
        action: r.type === 'reaction_added' ? 'added' : 'removed',
        emoji: r.reaction,
        trigger: 'replay',
        channel: r.item.channel,
        ts: r.item.ts,
        thread_ts: null,
        ...(r.item_user && { item_user: r.item_user }),
        permalink: permalink(d.teamUrl, { channel: r.item.channel!, ts: r.item.ts! } as SlackMessage),
        author: { id: r.user, name: await d.userName(r.user) },
        event_ts: r.event_ts,
        ...(s.own && { from_me: true }),
      })
    }
    const s = screen(p, d.me, d.allowBots)
    if ('skip' in s && s.skip !== 'own') return
    if (s.external) return matched(p)
    const m = p.event!
    const own = m.user === d.me.userId
    const author = m.user ?? m.bot_id ?? 'unknown'
    emit({
      kind: 'message',
      trigger: 'replay',
      channel: m.channel,
      channel_type: m.channel_type,
      ts: m.ts,
      thread_ts: m.thread_ts ?? null,
      permalink: permalink(d.teamUrl, m),
      author: { id: author, name: m.user ? await d.userName(m.user) : author },
      text: preview(m.text, FULL_TEXT),
      ...(own && { from_me: true }),
    })
  }

  const dir = mkdtempSync(`${tmpdir()}/slack-inbox-replay-`)
  try {
    const puller = createPuller({
      url: d.url,
      keys: d.keys,
      cursorFile: `${dir}/cursor`,
      log: d.log,
      fetch: d.fetch,
      now: d.now,
      handle: async p => {
        if (inFilter(p, d.filter)) await (d.filter.all ? everything(p) : matched(p))
      },
    })
    const r = await puller.pull()
    return { written, skipped: r.skipped, expired: r.lost, ...(r.error && { error: r.error }) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
