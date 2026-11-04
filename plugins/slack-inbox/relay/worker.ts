// Cloudflare Worker entry for the relay: a D1 queue, kept under its size limit by a daily cron trigger.
import { createRelay, MAX_QUEUE_BYTES, type Queued, rowsToEvict, type Store } from './handler'

type Env = {
  DB: any // D1Database
  SLACK_SIGNING_SECRET: string
  RELAY_SEAL_PUBLIC_KEY: string
  RELAY_VERIFY_PUBLIC_KEY: string
  RELAY_OWNER_USER_ID: string
  RELAY_MAX_QUEUE_BYTES?: string
}

const store = (db: Env['DB']): Store => ({
  async put(eventId, sealed) {
    // Checked first because even an ignored insert uses up an id, and the listener reads a jump in ids as lost events
    await db
      .prepare('INSERT OR IGNORE INTO events (event_id, sealed, expires_at) SELECT ?1, ?2, 0 WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_id = ?1)')
      .bind(eventId, sealed)
      .run()
  },
  async list(after, limit) {
    const r = await db.prepare('SELECT id, sealed FROM events WHERE id > ? ORDER BY id LIMIT ?').bind(after, limit).all()
    return r.results as Queued[]
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
    })(req),
  scheduled: async (_: unknown, env: Env) => {
    const { rows, bytes } = await env.DB.prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(sealed)), 0) AS bytes FROM events').first()
    const evict = rowsToEvict(rows, bytes, Number(env.RELAY_MAX_QUEUE_BYTES ?? MAX_QUEUE_BYTES))
    // Deleted pages are reused rather than returned, so the file stays near its peak but stops growing
    if (evict) await env.DB.prepare('DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id LIMIT ?)').bind(evict).run()
  },
}
