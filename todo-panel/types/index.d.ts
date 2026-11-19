export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/**
 * An item of the session's work: Claude's own (TodoWrite, the checklist,
 * TaskCreate/TaskUpdate), the person's request for a turn Claude made no list
 * for, or a step of Haiku's plan for that turn.
 */
export type ClaudeItem = {
  id: string
  source: 'todo' | 'task' | 'turn' | 'plan'
  content: string
  activeForm: string
  status: TodoStatus
}

/** An item the person added in the panel; kept per workspace in $.store. */
export type ManualItem = {
  id: string
  section: string
  text: string
  done: boolean
}

export type Prefs = {
  bandOn: boolean
  showDone: boolean
  autoOpen: boolean
  showActivity: boolean
  /** Ask Haiku for a one-line reason when Claude gave none. */
  aiReason: boolean
  /** Ask Haiku for a plan, and to tick it, when Claude made no list. */
  aiPlan: boolean
}

/** Where the main conversation's current turn stands. */
export type TurnInfo = {
  id: string
  /** Tool calls so far, todo tools left out. */
  calls: number
  /** Claude made its own list this turn: no request item, no Haiku plan. */
  hasClaudeList: boolean
  /** Haiku was asked for a plan this turn. */
  isPlanAsked: boolean
}

/** One tool call Claude made in the main conversation during this turn. */
export type ActivityItem = {
  id: string
  text: string
  status: 'running' | 'done' | 'error'
  /** Why the call was made: Claude's own line, or Haiku's; '' while none. */
  why: string
  /** Who wrote `why`: Claude just before the call, or Haiku afterwards. */
  whyBy: 'claude' | 'ai' | ''
}

declare module 'claude-code' {
  interface PluginState {
    'todo-panel': {
      claude: ClaudeItem[]
      manual: ManualItem[]
      prefs: Prefs
      /** The main loop's model, as `/model` shows it; '' until read. */
      model: string
      /** The effort the main loop's last model request asked for (`high`); '' when none was sent. */
      effort: string
      /** The current (or last) turn's tool calls, oldest first. */
      activity: ActivityItem[]
      /** The last line Claude wrote in this turn, the reason for the next calls. */
      narration: string
      /** The person's prompt that started this turn, as context for Haiku. */
      turnPrompt: string
      turn: TurnInfo
      /** The workspace whose items were put back from the store; '' after a reset. */
      restoredFor: string
      /** Skills expanded since the main turn began (`/name`, the Skill tool, a preload), in order. */
      skills: string[]
    }
  }
}
