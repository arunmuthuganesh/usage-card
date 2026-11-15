import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Feed, Limit } from '../types'

const limits = atom({ plugin: 'usage-card', key: 'limits' } as const, [])
const now = atom({ plugin: 'usage-card', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'usage-card', key: 'isHidden' } as const, false)
const NO_FEED: Feed = { source: 'none', updatedAt: 0 }
const feed = atom({ plugin: 'usage-card', key: 'feed' } as const, NO_FEED)

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const POLL_MS = 60_000
const BACKOFF_MS = 5 * 60_000
const LABELS: Record<string, string> = { five_hour: 'Session', seven_day: 'Weekly' }
const KINDS = ['five_hour', 'seven_day']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const BAR = 20

const pickLimits = (all: Limit[]): Limit[] =>
  KINDS.flatMap(kind => all.filter(one => one.kind === kind))

// The usage API answers { five_hour: { utilization, resets_at }, seven_day: {...}, ... }.
export const parseUsage = (body: unknown): Limit[] => {
  if (typeof body !== 'object' || body === null) return []
  const windows = body as Record<string, { utilization?: unknown; resets_at?: unknown } | null>

  return KINDS.flatMap(kind => {
    const window = windows[kind]
    if (!window || typeof window.utilization !== 'number') return []
    const limit: Limit = { kind, percentUsed: Math.round(window.utilization * 10) / 10 }
    if (typeof window.resets_at === 'string') limit.resetsAt = window.resets_at

    return [limit]
  })
}

const bar = (percent: number): string => {
  const filled = Math.max(0, Math.min(BAR, Math.round((percent / 100) * BAR)))

  return '█'.repeat(filled) + '░'.repeat(BAR - filled)
}

const colorFor = (percent: number): string =>
  percent >= 90 ? 'red' : percent >= 70 ? 'yellow' : 'green'

export const clockTime = (date: Date): string => {
  const hours = date.getHours()
  const minutes = String(date.getMinutes()).padStart(2, '0')

  return `${hours % 12 || 12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`
}

// "3:40 PM", or "Thu 9:00 AM" when the reset is not today.
export const endTime = (resetsAt: string, nowMs: number): string => {
  const end = new Date(resetsAt)
  const isToday = end.toDateString() === new Date(nowMs).toDateString()

  return isToday ? clockTime(end) : `${DAYS[end.getDay()]} ${clockTime(end)}`
}

export const timeLeft = (resetsAt: string, nowMs: number): string => {
  const minutes = Math.max(0, Math.round((Date.parse(resetsAt) - nowMs) / 60000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`

  return `${mins}m`
}

// The module's own: they start over on each load.
let nextPollAt = 0
let isPolling = false
let apiError = ''

async function fail($: EngineInterface, error: string, retryMs: number): Promise<void> {
  nextPollAt = Date.now() + retryMs
  await update($, feed, old => ({ ...old, error }))
}

/** The usage API: fast, but only with a subscription login this session can lend. */
async function fromApi($: EngineInterface): Promise<Limit[]> {
  const auth = await $.session.authorize()
  if (!auth || auth.kind !== 'bearer') throw new Error('no subscription login to lend')
  const res = await $.http.fetch(USAGE_URL, {
    auth: auth.handle,
    headers: { 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  return parseUsage(JSON.parse(res.text))
}

// Reads the account's current usage, which counts every session and claude.ai too:
// the usage API first, this session's own reply figures when the API is out of reach.
// It never runs a terminal command: `claude -p /usage` can be logged in to another account.
async function poll($: EngineInterface): Promise<void> {
  if (isPolling || Date.now() < nextPollAt) return
  isPolling = true
  try {
    let fresh: Limit[] = []
    try {
      fresh = await fromApi($)
      apiError = ''
    } catch (error) {
      apiError = error instanceof Error ? error.message : String(error)
    }
    let source: Feed['source'] = 'live'
    if (fresh.length === 0) {
      fresh = pickLimits((await $.session.usage()).rateLimits)
      if (fresh.length > 0) source = 'reply'
    }
    if (fresh.length === 0) {
      await fail($, `Live refresh found no limits (usage API: ${apiError || 'empty'}).`, POLL_MS)
      return
    }
    nextPollAt = 0
    await share($, fresh)
    await update($, limits, () => fresh)
    await update($, feed, () => ({ source, updatedAt: Date.now() }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await fail($, `Live refresh failed (${message.slice(0, 80)}${apiError ? `; usage API: ${apiError}` : ''}).`, BACKOFF_MS)
  } finally {
    isPolling = false
  }
}

/** Leaves the latest reading where turn-cost can find it (balance.mjs's cache file, own key). */
async function share($: EngineInterface, fresh: Limit[]): Promise<void> {
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
  const cachePath = `${home}/.claude/delegation-state/balance-cache.json`
  let cache: Record<string, unknown> = {}
  try {
    cache = JSON.parse(await $.fs.read(cachePath))
  } catch {
    cache = {}
  }
  const pct = (kind: string) => fresh.find(one => one.kind === kind)?.percentUsed
  cache.usageCardLimits = { at: Date.now(), value: { fiveHour: pct('five_hour'), weekly: pct('seven_day') } }
  await $.fs.write(cachePath, JSON.stringify(cache)).catch(() => undefined)
}

async function tick($: EngineInterface): Promise<void> {
  await update($, now, () => Date.now())
  await poll($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-card',
      description: 'Show or hide the live session and weekly usage card',
    })
    const fromReply = pickLimits((await $.session.usage()).rateLimits)
    if (fromReply.length > 0) {
      await share($, fromReply)
      await update($, limits, () => fromReply)
      await update($, feed, () => ({ source: 'reply', updatedAt: Date.now() }))
    }
    void tick($)
    $.clock.every(POLL_MS, () => tick($))

    return next(e)
  })

  // Each reply carries fresh figures in its headers: show them at once.
  on('session.measure', async ($, e, next) => {
    const fromReply = pickLimits(e.rateLimits)
    if (e.changed.includes('rateLimits') && fromReply.length > 0) {
      await share($, fromReply)
      await update($, limits, () => fromReply)
      // A live reading stays the label while it is recent; an error stays shown.
      await update($, feed, old =>
        old.source === 'live' && Date.now() - old.updatedAt < 2 * POLL_MS
          ? old
          : { ...old, source: 'reply', updatedAt: Date.now() },
      )
    }

    return next(e)
  })

  on('command.run', { command: 'usage-card' }, async $ => {
    const hidden = !(await read($, isHidden))
    await update($, isHidden, () => hidden)
    if (!hidden) {
      nextPollAt = 0
      void tick($)
    }

    return { text: hidden ? 'Usage card hidden.' : 'Usage card shown and refreshing.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, limits)
    const nowMs = (await read($, now)) || Date.now()
    const status = await read($, feed)
    const isLive = status.source === 'live'
    const label = isLive ? '● Live' : status.source === 'reply' ? '○ From last reply' : ''
    const updated = status.updatedAt > 0 ? ` · updated ${clockTime(new Date(status.updatedAt))}` : ''

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Box key="head">
          <Text bold>Claude usage </Text>
          <Text color={isLive ? 'green' : 'yellow'}>{label}</Text>
          <Text dimColor>{updated}</Text>
        </Box>
        {list.length === 0 && <Text dimColor>Fetching usage…</Text>}
        {list.map(limit => (
          <Box key={limit.kind}>
            <Text>{(LABELS[limit.kind] ?? limit.kind).padEnd(8)}</Text>
            <Text color={colorFor(limit.percentUsed)}>{bar(limit.percentUsed)}</Text>
            <Text bold> {String(Math.round(limit.percentUsed)).padStart(3)}%</Text>
            {limit.resetsAt ? (
              <Text dimColor>
                {'  '}ends {endTime(limit.resetsAt, nowMs)} (in {timeLeft(limit.resetsAt, nowMs)})
              </Text>
            ) : (
              <Text dimColor>{'  '}no reset time reported</Text>
            )}
          </Box>
        ))}
        {status.error && <Text dimColor>{status.error}</Text>}
      </Box>
    )
  })
}
