import { test, expect, mock } from 'claude-code/testing'

const PROPS = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } as never

// The list is kept in state for todo-panel to draw; the band no longer shows
// it. The test watches the writes to that state from beneath the plugin.
const standIn = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  const written: { value: unknown } = { value: undefined }
  mock.clock(on)
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] },
  }))
  on('state.set', { plugin: 'usage-band', key: 'todos' }, ($, e, next) => {
    written.value = e.value
    return next(e)
  })
  return written
}

const bandShowsNoTodos = async ($: Parameters<Parameters<typeof test>[1]>[0]) => {
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Text', text: '할 일 ' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ \d+\/\d+$/ })).toBeUndefined()
  await ui.unmount()
}

test('TodoWrite: keeps the whole list in state', async ($, on) => {
  const written = standIn(on)
  on('tool.call', (_$, e) => ({ result: { oldTodos: [], newTodos: (e as any).todos } }))

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read files', activeForm: 'Reading files', status: 'completed' },
      { content: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' },
      { content: 'Run tests', activeForm: 'Running tests', status: 'pending' },
    ],
  })

  expect(written.value).toEqual([
    { id: '0', text: 'Read files', activeText: 'Reading files', status: 'completed' },
    { id: '1', text: 'Write tests', activeText: 'Writing tests', status: 'in_progress' },
    { id: '2', text: 'Run tests', activeText: 'Running tests', status: 'pending' },
  ])
  await bandShowsNoTodos($)
})

test('TaskCreate / TaskUpdate: adds, then updates the status', async ($, on) => {
  const written = standIn(on)
  let next = 0
  on('tool.call', (_$, e) =>
    (e as any).tool === 'TaskCreate'
      ? { result: { task: { id: String(++next), subject: (e as any).subject } } }
      : { result: { success: true, taskId: (e as any).taskId, updatedFields: ['status'] } },
  )

  await $.tool.call({ tool: 'TaskCreate', subject: 'Fix bug', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Add test', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })

  expect(written.value).toEqual([
    { id: '1', text: 'Fix bug', activeText: 'Fix bug', status: 'completed' },
    { id: '2', text: 'Add test', activeText: 'Add test', status: 'pending' },
  ])
  await bandShowsNoTodos($)
})

test('own checklist tool: replaces the list in state', async ($, on) => {
  const written = standIn(on)

  const ran = await $.tool.call({
    tool: 'mcp__usage-band__checklist',
    todos: [
      { content: 'Plan', status: 'completed' },
      { content: 'Build', activeForm: 'Building', status: 'in_progress' },
    ],
  } as never)
  expect((ran as { result?: unknown }).result).toBe('Checklist updated: 1/2 completed.')

  expect(written.value).toEqual([
    { id: '0', text: 'Plan', activeText: 'Plan', status: 'completed' },
    { id: '1', text: 'Build', activeText: 'Building', status: 'in_progress' },
  ])
  await bandShowsNoTodos($)
})
