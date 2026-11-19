/** One session row as the pane draws it. */
export type PaneRow = {
  id: string
  num: number
  title: string
  where: string
  when: string
  /** What `/resume` takes for it: its name when unique, else its id. */
  handle: string
  isCurrent: boolean
  isActive: boolean
}

export type PaneData = {
  repoName: string
  keyword: string | null
  rows: PaneRow[]
  /** The active session pressed once, waiting for a second press. */
  confirmId: string | null
  notice: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'repo-sessions': { pane: PaneData | null }
  }
}
