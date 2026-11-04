// Cloudflare Worker entry for the relay: a D1 queue the listener empties as it collects, with a daily cron trigger
// to delete what nobody collected and keep it under its size limit.
import { createRelay, MAX_AGE_MS, MAX_QUEUE_BYTES, type Queued, rowsToEvict, type Store } from './handler'

type Env = {
  DB: any // D1Database
  SLACK_SIGNING_SECRET: string
  RELAY_SEAL_PUBLIC_KEY: string
  RELAY_VERIFY_PUBLIC_KEY: string
  RELAY_OWNER_USER_ID: string
  RELAY_MAX_QUEUE_BYTES?: string
  RELAY_MAX_AGE_DAYS?: string
}

const maxAgeMs = (env: Env) => (env.RELAY_MAX_AGE_DAYS ? Number(env.RELAY_MAX_AGE_DAYS) * 86_400_000 : MAX_AGE_MS)

const store = (db: Env['DB']): Store => ({
  async put(eventId, sealed, expiresAt) {
    // Checked first because even an ignored insert uses up an id, and the listener reads a jump in ids as lost events
    await db
      .prepare('INSERT OR IGNORE INTO events (event_id, sealed, expires_at) SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_id = ?1)')
      .bind(eventId, sealed, expiresAt)
      .run()
  },
  async list(after, limit) {
    const r = await db.prepare('SELECT id, sealed FROM events WHERE id > ? ORDER BY id LIMIT ?').bind(after, limit).all()
    return r.results as Queued[]
  },
  async ack(through) {
    await db.prepare('DELETE FROM events WHERE id <= ?').bind(through).run()
  },
})

export default {
  fetch: (req: Request, env: Env) =>
    createRelay({
      signingSecret: env.SLACK_SIGNING_SECRET,
      sealKey: env.RELAY_SEAL_PUBLIC_KEY,
      verifyKey: env.RELAY_VERIFY_PUBLIC_KEY,
      ownerUserId: env.RELAY_OWNER_USER_ID,
      store: store(env.DB),
      maxAgeMs: maxAgeMs(env),
    })(req),
  scheduled: async (_: unknown, env: Env) => {
    await env.DB.prepare('DELETE FROM events WHERE expires_at < ?').bind(Date.now()).run()
    const { rows, bytes } = await env.DB.prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(sealed)), 0) AS bytes FROM events').first()
    const evict = rowsToEvict(rows, bytes, Number(env.RELAY_MAX_QUEUE_BYTES ?? MAX_QUEUE_BYTES))
    // Deleted pages are reused rather than returned, so the file stays near its peak but stops growing
    if (evict) await env.DB.prepare('DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id LIMIT ?)').bind(evict).run()
  },
}
