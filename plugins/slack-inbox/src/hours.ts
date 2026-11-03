// Working hours: the listener stays connected only inside them. Times are the machine's local time.

export type Hours = { start: number; end: number; days: Set<number> } // minutes after midnight; 0 = Sunday

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function minutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m || +m[1] > 24 || +m[2] > 59 || (+m[1] === 24 && +m[2] > 0)) throw new Error(`bad time "${hhmm}", want HH:MM`)
  return +m[1] * 60 + +m[2]
}

function day(name: string): number {
  const i = DAY_NAMES.indexOf(name.trim().toLowerCase().slice(0, 3))
  if (i < 0) throw new Error(`bad day "${name}", want mon, tue, ...`)
  return i
}

// "mon-fri", "mon,wed,fri", "fri-mon" (wraps), "all".
export function parseDays(spec: string): Set<number> {
  if (spec.trim().toLowerCase() === 'all') return new Set([0, 1, 2, 3, 4, 5, 6])
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-')
    if (b === undefined) out.add(day(a))
    else for (let d = day(a), end = day(b); ; d = (d + 1) % 7) {
      out.add(d)
      if (d === end) break
    }
  }
  return out
}

// "09:00-18:00". An end before the start runs past midnight, and counts as the day it started on.
export function parseHours(range: string, days = 'mon-fri'): Hours {
  const [a, b] = range.split('-')
  if (b === undefined) throw new Error(`bad hours "${range}", want HH:MM-HH:MM`)
  const start = minutes(a)
  const end = minutes(b)
  if (start === end) throw new Error(`hours "${range}" start and end at the same time`)
  return { start, end, days: parseDays(days) }
}

export function inHours(h: Hours | undefined, now: Date): boolean {
  if (!h) return true
  const t = now.getHours() * 60 + now.getMinutes()
  const today = now.getDay()
  if (h.start < h.end) return h.days.has(today) && t >= h.start && t < h.end
  return (h.days.has(today) && t >= h.start) || (h.days.has((today + 6) % 7) && t < h.end)
}
