// Cloudflare Worker entry for the relay: a D1 queue, emptied of anything past its expiry by a cron trigger.
import { createRelay, type Queued, type Store } from './handler'

type Env = {
  DB: any // D1Database
  SLACK_SIGNING_SECRET: string
  RELAY_SEAL_PUBLIC_KEY: string
  RELAY_VERIFY_PUBLIC_KEY: string
  RELAY_OWNER_USER_ID: string
}

const store = (db: Env['DB']): Store => ({
  async put(eventId, sealed, expiresAt) {
    await db.prepare('INSERT OR IGNORE INTO events (event_id, sealed, expires_at) VALUES (?, ?, ?)').bind(eventId, sealed, expiresAt).run()
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
    await env.DB.prepare('DELETE FROM events WHERE expires_at < ?').bind(Date.now()).run()
  },
}
