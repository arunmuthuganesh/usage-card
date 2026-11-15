export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** Where the figures came from: the live usage API, or the last reply's headers. */
export type Feed = { source: 'live' | 'reply' | 'none'; updatedAt: number; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-card': { limits: Limit[]; now: number; isHidden: boolean; feed: Feed }
  }
}
