import { atom, update } from 'claude-code'
import type { Register, SessionRateLimit } from 'claude-code'

import type { Todo } from '../types'

// Claude's checklist, kept in session state so a reload does not lose it
const todos = atom({ plugin: 'usage-band', key: 'todos' } as const, [])

const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5시간',
  seven_day: '주간',
  spend_limit: '지출',
}

const CHECKLIST_TOOL = 'mcp__usage-band__checklist'

// Theme colour for a percentage: calm, then warning, then error
const tone = (percent: number) =>
  percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'subtle'

// 84321 -> "84k"
const kilo = (tokens: number) => `${Math.round(tokens / 1000)}k`

// Time left until an ISO timestamp, as "2d3h", "2h10m" or "35m"
const left = (resetsAt: string, now: number) => {
  const minutes = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60000))
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d${hours % 24}h`
  return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`
}

// A meter like "████░░░░░░ 42%", the filled part coloured by how full it is;
// with no cells, the percentage alone
const Bar = ({ Text, percent, cells }: { Text: any; percent: number; cells: number }) => {
  const filled = Math.min(cells, Math.round((percent / 100) * cells))
  return (
    <Text>
      <Text color={tone(percent)}>{'█'.repeat(filled)}</Text>
      <Text color="subtle">{'░'.repeat(cells - filled)}</Text>
      <Text color={tone(percent)}>{`${cells > 0 ? ' ' : ''}${percent}%`}</Text>
    </Text>
  )
}

// Cells a string takes in a terminal: Hangul and other wide scripts take two
const cellWidth = (text: string) => {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60)
    width += isWide ? 2 : 1
  }
  return width
}

// One figure of the band: a label, a meter when it has a percentage, a detail
type Segment = { key: string; label: string; percent?: number; detail?: string }

// How much of each figure to draw, richest first
type Detail = { cells: number; withDetail: boolean }
const DETAILS: Detail[] = [
  { cells: 10, withDetail: true },
  { cells: 5, withDetail: true },
  { cells: 5, withDetail: false },
  { cells: 0, withDetail: false },
]

const SEPARATOR = ' · '
const MAX_ROWS = 3

const segmentWidth = (segment: Segment, { cells, withDetail }: Detail) => {
  const meter =
    segment.percent === undefined ? 0 : 1 + cells + (cells > 0 ? 1 : 0) + `${segment.percent}%`.length
  const detail = withDetail && segment.detail ? 1 + cellWidth(segment.detail) : 0
  return cellWidth(segment.label) + meter + detail
}

// Packs whole figures into rows of at most `columns` cells, in order
const pack = (segments: Segment[], detail: Detail, columns: number) => {
  const rows: Segment[][] = []
  let width = 0
  for (const segment of segments) {
    const own = segmentWidth(segment, detail)
    const row = rows[rows.length - 1]
    if (row && width + SEPARATOR.length + own <= columns) {
      row.push(segment)
      width += SEPARATOR.length + own
    } else {
      rows.push([segment])
      width = own
    }
  }
  return rows
}

// The richest drawing that fits: one row at full detail, else whole figures
// over a few rows, giving up meter cells and then details as room runs out
const layout = (segments: Segment[], columns: number) => {
  const fits = (rows: Segment[][], detail: Detail) =>
    rows.length <= MAX_ROWS &&
    rows.every(row => row.every(segment => segmentWidth(segment, detail) <= columns))
  const full = DETAILS[0]!
  const oneRow = pack(segments, full, columns)
  if (oneRow.length === 1 && fits(oneRow, full)) return { rows: oneRow, detail: full }
  for (const detail of DETAILS) {
    const rows = pack(segments, detail, columns)
    if (fits(rows, detail)) return { rows, detail }
  }
  const last = DETAILS[DETAILS.length - 1]!
  return { rows: pack(segments, last, columns), detail: last }
}

const isOk = (ran: { deny?: string; isError?: boolean }) =>
  ran.deny === undefined && !ran.isError

type ChecklistInput = { todos?: { content: string; activeForm?: string; status: string }[] }

export const register: Register = on => {
  // Give Claude a checklist tool of our own, so the band works even where
  // the built-in TodoWrite / Task tools are not available
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'checklist',
      description:
        'Track progress on any request that takes two or more tool calls: code ' +
        'changes, but also research, answering questions, running a skill or a ' +
        'procedure. Call it BEFORE the first other tool call with the steps you ' +
        'plan, written in the language the user writes in. Send the WHOLE list ' +
        'every time (it replaces the previous one). Mark exactly one item ' +
        'in_progress while working on it and mark items completed as soon as ' +
        'they are done; add steps as you discover them. Send an empty list to ' +
        'clear it. The user watches this list in the todo panel to follow your work.',
      inputSchema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'The step, imperative ("Run tests")' },
                activeForm: { type: 'string', description: 'Shown while in progress ("Running tests")' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
      isDeferred: false,
    })
    return next(e)
  })

  // Serve the checklist tool
  on('tool.call', { tool: CHECKLIST_TOOL }, async ($, e) => {
    const input = (e as unknown as ChecklistInput).todos ?? []
    const list: Todo[] = input.map((todo, i) => ({
      id: String(i),
      text: todo.content,
      activeText: todo.activeForm ?? todo.content,
      status: todo.status,
    }))
    await update($, todos, () => list)
    $.ui.invalidate('ui.render')
    const done = list.filter(todo => todo.status === 'completed').length
    return { result: `Checklist updated: ${done}/${list.length} completed.` }
  })

  // TodoWrite sends the whole list every time
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (isOk(ran)) {
      const list: Todo[] = e.todos.map((todo, i) => ({
        id: String(i),
        text: todo.content,
        activeText: todo.activeForm,
        status: todo.status,
      }))
      await update($, todos, () => list)
      $.ui.invalidate('ui.render')
    }
    return ran
  }).catch(($, e, next) => next(e))

  // TaskCreate adds one item; its id comes back in the result
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (isOk(ran) && ran.result?.task) {
      const task: Todo = {
        id: ran.result.task.id,
        text: e.subject,
        activeText: e.activeForm ?? e.subject,
        status: 'pending',
      }
      await update($, todos, list => [...list, task])
      $.ui.invalidate('ui.render')
    }
    return ran
  }).catch(($, e, next) => next(e))

  // TaskUpdate changes one item's status or wording
  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (isOk(ran)) {
      await update($, todos, list =>
        list
          .filter(todo => !(todo.id === e.taskId && e.status === 'deleted'))
          .map(todo =>
            todo.id === e.taskId
              ? {
                  ...todo,
                  text: e.subject ?? todo.text,
                  activeText: e.activeForm ?? e.subject ?? todo.activeText,
                  status: e.status ?? todo.status,
                }
              : todo,
          ),
      )
      $.ui.invalidate('ui.render')
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Redraw the band whenever the engine's figures move
  on('session.measure', ($, e, next) => {
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { context, rateLimits, cost } = await $.session.usage()
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)

    const segments: Segment[] = [
      {
        key: 'context',
        label: context.percent === undefined ? '컨텍스트 -' : '컨텍스트',
        percent: context.percent,
        detail: context.tokens !== undefined ? `(${kilo(context.tokens)}/${kilo(context.window)})` : undefined,
      },
      ...rateLimits.map((limit: SessionRateLimit) => ({
        key: limit.kind,
        label: LIMIT_NAMES[limit.kind] ?? limit.kind,
        percent: limit.percentUsed,
        detail: limit.resetsAt !== undefined ? `(${left(limit.resetsAt, now)})` : undefined,
      })),
      ...(cost !== undefined ? [{ key: 'cost', label: `$${cost.usd.toFixed(2)}` }] : []),
    ]
    const { rows, detail } = layout(segments, Math.max(1, e.props.bodyColumns))

    // Claude's checklist is drawn by todo-panel, which reads it from this state
    return (
      <Box flexDirection="column">
        {rows.map((row, index) => (
          <Box key={`row-${index}`} flexDirection="row">
            {row.map((segment, at) => (
              <Text key={segment.key} wrap="truncate-end">
                {at > 0 ? <Text color="subtle">{SEPARATOR}</Text> : null}
                <Text color="subtle">{segment.label}</Text>
                {segment.percent !== undefined ? (
                  <Text>
                    <Text> </Text>
                    {Bar({ Text, percent: segment.percent, cells: detail.cells })}
                  </Text>
                ) : null}
                {detail.withDetail && segment.detail ? <Text color="subtle"> {segment.detail}</Text> : null}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
