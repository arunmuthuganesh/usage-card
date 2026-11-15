import { describe, expect, test } from 'claude-code/testing'

import { endTime, parseUsage, timeLeft } from './register'

const SURFACES = ['terminal', 'desktop'] as const

describe('usage-card', () => {
  test('time left reads in days, hours or minutes', async () => {
    const now = Date.parse('2026-10-20T10:00:00Z')
    expect(timeLeft('2026-10-20T10:45:00Z', now)).toBe('45m')
    expect(timeLeft('2026-10-20T12:30:00Z', now)).toBe('2h 30m')
    expect(timeLeft('2026-10-23T13:00:00Z', now)).toBe('3d 3h')
    expect(timeLeft('2026-10-20T09:00:00Z', now)).toBe('0m')
  })

  test('end time names the day only when it is not today', async () => {
    const now = new Date(2026, 9, 20, 10, 0).getTime()
    expect(endTime(new Date(2026, 9, 20, 15, 5).toISOString(), now)).toBe('3:05 PM')
    expect(endTime(new Date(2026, 9, 22, 9, 0).toISOString(), now)).toBe('Thu 9:00 AM')
  })

  test('reads the session and weekly windows from the usage API', async () => {
    const body = {
      five_hour: { utilization: 42.04, resets_at: '2026-10-20T15:00:00Z' },
      seven_day: { utilization: 17, resets_at: '2026-10-23T09:00:00Z' },
      seven_day_opus: null,
    }
    expect(parseUsage(body)).toEqual([
      { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-20T15:00:00Z' },
      { kind: 'seven_day', percentUsed: 17, resetsAt: '2026-10-23T09:00:00Z' },
    ])
    expect(parseUsage({ five_hour: null })).toEqual([])
    expect(parseUsage('nope')).toEqual([])
  })

  for (const surface of SURFACES) {
    test(`draws the card on ${surface}`, async $ => {
      const ui = await $.ui.mount({
        plugin: 'usage-card',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false },
      })
      expect(await ui.find({ text: 'Fetching usage…' })).toBeDefined()
    })
  }
})
