import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const CWD = '/work/app'
const EMPTY = '할 일이 없습니다'
const BAND_LINE = /^☑ \d+\/\d+/

const PANE = {
  component: 'Pane',
  requestId: 'todo-panel',
  props: {
    title: 'Todo',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 5 },
    view: {},
  },
} as const

/**
 * The panel as a reader sees it: each row as its mark, a space and the rest
 * (indented by its padding), and every other text or button on a line of its own.
 */
async function linesOf(ui: { drawn: () => Promise<unknown> }): Promise<string[]> {
  const flat = (node: any): string =>
    typeof node === 'string'
      ? node
      : node?.children?.length
        ? node.children.map(flat).join('')
        : String(node?.props?.label ?? '')
  const lines: string[] = []
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    const key = String(node.props?.key ?? '')
    if (node.type === 'Box' && key.startsWith('row-')) {
      const [mark, ...rest] = node.children ?? []
      lines.push(`${' '.repeat(node.props.paddingLeft ?? 0)}${flat(mark)} ${rest.map(flat).join('')}`)
    } else if (node.type === 'Text' || node.type === 'Button') {
      lines.push(flat(node))
    } else {
      ;(node.children ?? []).forEach(walk)
    }
  }
  walk(await ui.drawn())
  return lines
}

/** The first line holding `match` (by inclusion, or a pattern), as `{ text }`. */
async function line(ui: { drawn: () => Promise<unknown> }, match: string | RegExp) {
  const found = (await linesOf(ui)).find(one => (typeof match === 'string' ? one.includes(match) : match.test(one)))
  return found === undefined ? undefined : { text: found }
}

/**
 * Stands in for the engine beneath the plugin: the store, the session's
 * folder, command and pane registration, and the tools Claude tracks with.
 */
function world(on: On, seed: Record<string, unknown> = {}, { tools = true } = {}) {
  const opened: string[] = []
  const toasts: string[] = []
  const registered: string[] = []
  const session = { model: 'claude-opus-5-5' }
  mock.store(on, seed)
  on('session.cwd', () => ({ value: CWD }))
  on('session.model', () => ({ value: session.model }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('command.register', ($, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  if (tools) {
    on('tool.call', { tool: 'TodoWrite' }, ($, e) => ({
      result: { oldTodos: [], newTodos: e.todos },
    }))
    on('tool.call', { tool: 'TaskCreate' }, ($, e) => ({
      result: { task: { id: String(e.subject.length), subject: e.subject } },
    }))
    on('tool.call', { tool: 'TaskUpdate' }, ($, e) => ({
      result: { success: true, taskId: e.taskId, updatedFields: ['status'] },
    }))
  }
  // What the band's other drawers put there: the plugin must keep it.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'downstream' }, 'downstream band')
  })
  return { opened, toasts, registered, session }
}

describe('command and pane', () => {
  test('registers /todo-panel and opens only its own pane on the command', async ($, on) => {
    const { opened, registered } = world(on, { prefs: { bandOn: true, showDone: true, autoOpen: false } })
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    expect(registered).toContain('todo-panel')
    expect(opened).toHaveLength(0)

    const ran = await $.command.run({
      command: 'todo-panel',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })
    expect(opened).toEqual(['todo-panel'])
    expect(ran.text).toContain('할 일 패널')
  })

  test('opens the pane at start unless turned off in the panel', async ($, on) => {
    const { opened } = world(on)
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    expect(opened).toEqual(['todo-panel'])

    const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface: 'terminal' })
    expect((await ui.find({ key: 'auto-open-toggle' }))?.text).toBe('시작 시 열기: 켜짐')
    await ui.press({ key: 'auto-open-toggle' })
    expect((await ui.find({ key: 'auto-open-toggle' }))?.text).toBe('시작 시 열기: 꺼짐')

    // The choice is kept in the store, so the next start leaves the pane closed.
    opened.length = 0
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    expect(opened).toHaveLength(0)
  })

  test(
    "leaves another plugin's pane alone",
    {
      plugins: [
        {
          name: 'other-pane',
          register(on) {
            on('ui.render', { component: 'Pane', requestId: 'other' }, ($, e) => {
              const { Text } = $.ui.resolve(e)
              return h(Text, { key: 'other-body' }, 'other plugin body')
            })
          },
        },
      ],
    },
    async ($, on) => {
      world(on)
      for (const surface of SURFACES) {
        const ui = await $.ui.mount({ ...PANE, requestId: 'other', plugin: 'other-pane', surface })
        expect(await line(ui, 'other plugin body')).toBeDefined()
        expect(await ui.find({ text: /완료 \d+ \/ 전체/ })).toBeUndefined()
        await ui.unmount()
      }
    },
  )
})

for (const surface of SURFACES) {
  describe(`on ${surface}`, () => {
    test('shows the empty state', async ($, on) => {
      world(on)
      const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })
      expect(await line(ui, EMPTY)).toBeDefined()
      expect(await ui.find({ text: '완료 0 / 전체 0' })).toBeDefined()
      expect(await ui.find({ key: 'add' })).toBeDefined()
    })

    test('TaskCreate adds an item and TaskUpdate completed ticks it', async ($, on) => {
      const { toasts } = world(on)
      const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })

      const created = await $.tool.call({ tool: 'TaskCreate', subject: '테스트 작성', description: 'd' })
      expect(created.isError).toBeUndefined()
      expect(await line(ui, '☐ 테스트 작성')).toBeDefined()
      expect(await ui.find({ text: '완료 0 / 전체 1' })).toBeDefined()

      await $.tool.call({ tool: 'TaskUpdate', taskId: '6', status: 'in_progress', activeForm: '테스트 작성 중' })
      expect(await line(ui, '▶ 테스트 작성 중')).toBeDefined()

      await $.tool.call({ tool: 'TaskUpdate', taskId: '6', status: 'completed' })
      expect(await line(ui, '☑ 테스트 작성')).toBeDefined()
      expect(await ui.find({ text: '완료 1 / 전체 1' })).toBeDefined()
      expect(toasts).toHaveLength(1)

      await $.tool.call({ tool: 'TaskUpdate', taskId: '6', status: 'deleted' })
      expect(await line(ui, /테스트 작성/)).toBeUndefined()
      expect(await line(ui, EMPTY)).toBeDefined()
    })

    test('TodoWrite replaces the list and ticks completed items', async ($, on) => {
      world(on)
      const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })
      await $.tool.call({
        tool: 'TodoWrite',
        todos: [
          { content: '설계', status: 'completed', activeForm: '설계 중' },
          { content: '구현', status: 'in_progress', activeForm: '구현 중' },
          { content: '검증\u0007\u001b[31m', status: 'pending', activeForm: '검증 중' },
        ],
      })
      expect(await line(ui, '☑ 설계')).toBeDefined()
      expect(await line(ui, '▶ 구현 중')).toBeDefined()
      // Control characters are stripped before drawing.
      expect(await line(ui, '☐ 검증 [31m')).toBeDefined()
      expect(await ui.find({ text: '완료 1 / 전체 3' })).toBeDefined()
      expect(await line(ui, ' [Claude]')).toBeDefined()
    })

    test(
      "follows usage-band's checklist, whatever the plugins' order",
      {
        plugins: [
          {
            name: 'usage-band',
            register(on) {
              // Like usage-band: answers its own tool and keeps the list in its state.
              on('tool.call', { tool: 'mcp__usage-band__checklist' }, async ($, e) => {
                const todos = (e as any).todos as { content: string; activeForm?: string; status: string }[]
                const list = todos.map((todo, i) => ({
                  id: String(i),
                  text: todo.content,
                  activeText: todo.activeForm ?? todo.content,
                  status: todo.status,
                }))
                await ($.state.set as any)({ plugin: 'usage-band', key: 'todos' }, list)
                return { result: 'Checklist updated' }
              })
            },
          },
        ],
      },
      async ($, on) => {
        world(on)
        const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })
        const ran = await ($.tool.call as any)({
          tool: 'mcp__usage-band__checklist',
          todos: [
            { content: '추적 추가', activeForm: '추적 추가 중', status: 'completed' },
            { content: '모델 표시', activeForm: '모델 표시 중', status: 'in_progress' },
            { content: '검증', status: 'pending' },
          ],
        })
        expect(ran.isError, JSON.stringify(ran)).toBeUndefined()
        expect(await line(ui, '☑ 추적 추가')).toBeDefined()
        expect(await line(ui, '▶ 모델 표시 중')).toBeDefined()
        expect(await line(ui, '☐ 검증')).toBeDefined()
        expect(await ui.find({ text: '완료 1 / 전체 3' })).toBeDefined()

        await ($.tool.call as any)({ tool: 'mcp__usage-band__checklist', todos: [] })
        expect(await line(ui, EMPTY)).toBeDefined()
      },
    )

    test('shows the session model and follows a switch', async ($, on) => {
      const { session } = world(on)
      // The engine's model request beneath the plugin: an empty response.
      on('turn.step', async function* ($, e) {
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as any
      })
      const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })
      expect((await line(ui, /^모델:/))?.text).toBe('모델: 확인 중')

      await $.classic.SessionStart({ source: 'startup', cwd: CWD })
      expect((await line(ui, /^모델:/))?.text).toBe('모델: claude-opus-5-5')

      await $.classic.PostModelSwitch({
        from_model: 'claude-opus-5-5',
        to_model: 'claude-sonnet-5-5',
        requested_model: 'sonnet',
        source: 'command',
        context_tokens: 0,
        prompt_cache_warm: false,
        cache_ttl: '5m',
      })
      expect((await line(ui, /^모델:/))?.text).toBe('모델: claude-sonnet-5-5')

      // A switch no settings hook reports is picked up at the next turn.
      session.model = 'claude-haiku-5-5'
      await $.turn.start({ text: 'hi', turnId: 't1' })
      expect((await line(ui, /^모델:/))?.text).toBe('모델: claude-haiku-5-5')

      // The effort shows beside the model once a request of the main loop names one.
      const step = async (input: Record<string, unknown>) => {
        const stream: any = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 1, ...input } as any)
        if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
          for await (const _ of stream) {
            // read to the end
          }
        } else {
          await stream
        }
      }
      await step({ effort: 'xhigh', agentId: 'sub-1' })
      expect((await line(ui, /^모델:/))?.text).toBe('모델: claude-haiku-5-5')
      await step({ effort: 'high' })
      expect((await line(ui, /^모델:/))?.text).toBe('모델: claude-haiku-5-5 · effort: high')
      await step({ effort: 'low', index: 1 })
      expect((await line(ui, /^모델:/))?.text).toBe('모델: claude-haiku-5-5 · effort: low')

      const band = await $.ui.mount({ ...BAND, plugin: 'todo-panel', surface })
      await ui.input({ key: 'add', text: '하나' })
      await band.redraw()
      expect((await band.find({ type: 'Text', text: BAND_LINE }))?.text).toBe('☑ 0/1 · claude-haiku-5-5 (low)')
    })

    test("records this turn's tool calls as the search process", async ($, on) => {
      world(on)
      on('tool.call', { tool: 'Grep' }, () => ({ result: { mode: 'files_with_matches', filenames: [], numFiles: 0 } }))
      on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: { filePath: 'x', content: '' } } }))
      on('tool.call', { tool: 'Bash' }, () => ({ isError: true, result: 'boom', text: 'boom' }))
      const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })
      expect((await ui.find({ key: 'activity-fold' }))?.text).toBe('▾ 탐색 과정 (0)')
      expect(await line(ui, '이번 턴에 사용한 도구가 없습니다.')).toBeDefined()

      await $.tool.call({ tool: 'Grep', pattern: 'pane' })
      await $.tool.call({ tool: 'Read', file_path: 'C:\\work\\app\\hooks\\ui.js' })
      await $.tool.call({ tool: 'Bash', command: 'ls -la', description: '목록 보기' })
      await $.tool.call({
        tool: 'TodoWrite',
        todos: [{ content: '조사', status: 'in_progress', activeForm: '조사 중' }],
      })

      expect((await ui.find({ key: 'activity-fold' }))?.text).toBe('▾ 탐색 과정 (3)')
      expect(await line(ui, '✓ 검색 "pane"')).toBeDefined()
      expect(await line(ui, '✓ 읽기 ui.js')).toBeDefined()
      expect(await line(ui, '✗ 실행 목록 보기')).toBeDefined()
      // Todo tools are shown as todos, not again as activity.
      expect(await line(ui, /TodoWrite/)).toBeUndefined()

      await ui.press({ key: 'activity-fold' })
      expect(await line(ui, '✓ 검색 "pane"')).toBeUndefined()
      await ui.press({ key: 'activity-fold' })

      // A new turn of the main conversation starts a fresh list.
      await $.turn.start({ text: 'next', turnId: 't2' })
      expect((await ui.find({ key: 'activity-fold' }))?.text).toBe('▾ 탐색 과정 (0)')
    })

    test('puts what Claude said before the calls above them as the reason', async ($, on) => {
      world(on)
      on('tool.call', { tool: 'Grep' }, () => ({ result: { mode: 'files_with_matches', filenames: [], numFiles: 0 } }))
      const say = (uuid: string, text: string, agentId?: string) =>
        $.session.append({
          message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
          door: 'response',
          origin: { kind: 'model', model: 'claude-opus-5-5' },
          uuid,
          ...(agentId ? { agentId } : {}),
        } as any)
      const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })

      await say('u1', '좋습니다.\n\n먼저 **설정 파일**을 `grep`으로 찾아보겠습니다.')
      await $.tool.call({ tool: 'Grep', pattern: 'config' })
      await $.tool.call({ tool: 'Grep', pattern: 'settings' })
      await say('u2', '- 이제 테스트 쪽을 확인합니다.')
      await $.tool.call({ tool: 'Grep', pattern: 'test(' })

      const lines = (await linesOf(ui)).filter(one => /^ +(»|✓)/.test(one))
      expect(lines).toEqual([
        '  » 먼저 설정 파일을 grep으로 찾아보겠습니다.',
        '    ✓ 검색 "config"',
        '    ✓ 검색 "settings"',
        '  » 이제 테스트 쪽을 확인합니다.',
        '    ✓ 검색 "test("',
      ])

      // A new turn forgets the last reason.
      await $.turn.start({ text: 'next', turnId: 't3' })
      await $.tool.call({ tool: 'Grep', pattern: 'alone' })
      expect(await line(ui, /»/)).toBeUndefined()
      expect(await line(ui, '  ✓ 검색 "alone"')).toBeDefined()
    })

    test('asks Haiku for a reason only where Claude gave none, after the call', async ($, on) => {
      world(on)
      const clock = mock.clock(on)
      const asked: { model: string; prompt: string }[] = []
      on('model.complete', ($, e) => {
        // Only the one-line reasons; the plan's requests are tested on their own.
        if (String(e.system).includes('한 줄 설명')) asked.push({ model: e.model, prompt: e.prompt })
        return {
          value: {
            isAnswered: true,
            text: '원격 변경을 받아 사전 수집을 실행.',
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        }
      })
      on('tool.call', { tool: 'Grep' }, () => ({ result: { mode: 'files_with_matches', filenames: [], numFiles: 0 } }))
      on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
      const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })

      await $.turn.start({ text: 'ClickUp 동기화 해줘', turnId: 't4' })
      // Claude said nothing first: the call goes on, then Haiku fills the reason in.
      await $.tool.call({ tool: 'Bash', command: 'git pull && python pre.py', description: 'Pull and run pre-step' })
      expect(await line(ui, '  ✓ 실행 Pull and run pre-step')).toBeDefined()
      expect(await line(ui, /↳/)).toBeUndefined()
      await clock.settle()
      expect(await line(ui, '    ↳ 원격 변경을 받아 사전 수집을 실행')).toBeDefined()
      expect(asked).toHaveLength(1)
      expect(asked[0]!.model).toBe('haiku')
      expect(asked[0]!.prompt).toContain('사용자 요청: ClickUp 동기화 해줘')
      expect(asked[0]!.prompt).toContain('세부: git pull && python pre.py')

      // Claude's own line is used as is: no model call.
      await $.session.append({
        message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: '설정을 찾겠습니다.' }] },
        door: 'response',
        origin: { kind: 'model', model: 'claude-opus-5-5' },
        uuid: 'u10',
      } as any)
      await $.tool.call({ tool: 'Grep', pattern: 'config' })
      await clock.settle()
      expect(asked).toHaveLength(1)
      expect(await line(ui, '  » 설정을 찾겠습니다.')).toBeDefined()

      // A result in between uses that line up; the next call asks again.
      await $.session.append({
        message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
        door: 'tool-result',
        origin: { kind: 'tool', tool: 'Grep' },
        uuid: 'u11',
      } as any)
      await $.tool.call({ tool: 'Grep', pattern: 'other' })
      await clock.settle()
      expect(asked).toHaveLength(2)

      // Turned off in the panel: no more calls to Haiku.
      await ui.press({ key: 'ai-reason-toggle' })
      expect((await ui.find({ key: 'ai-reason-toggle' }))?.text).toBe('AI 설명(Haiku): 꺼짐')
      await $.tool.call({ tool: 'Grep', pattern: 'quiet' })
      await clock.settle()
      expect(asked).toHaveLength(2)
    })

    // Haiku as the plan and the checks see it: a fixed plan, step 1 done.
    const haiku = (on: On, asked: string[]) =>
      on('model.complete', ($, e) => {
        const system = String(e.system)
        const kind = system.includes('3~5단계') ? 'plan' : system.includes('진행 상황') ? 'check' : 'reason'
        asked.push(kind)
        const text =
          kind === 'plan' ? '- 설정 확인\n- 스크립트 실행\n- 결과 정리' : kind === 'check' ? '완료: 1\n진행: 2' : '이유'
        return {
          value: {
            isAnswered: true,
            text,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        }
      })
    const ended = (turnId: string, isAborted = false) =>
      ({ turnId, isAborted, answer: '', durationMs: 1, reason: isAborted ? 'aborted' : 'answer', category: null, explanation: null, text: '' }) as any

    test("puts the request up as a todo and Haiku's plan under it, ticked as work goes", async ($, on) => {
      const { toasts } = world(on)
      on('turn.complete', ($, e) => ({ text: '' }) as any)
      const clock = mock.clock(on)
      const asked: string[] = []
      haiku(on, asked)
      on('tool.call', { tool: 'Grep' }, () => ({ result: { mode: 'files_with_matches', filenames: [], numFiles: 0 } }))
      const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })

      await $.turn.start({ text: 'ClickUp 동기화 해줘\n자세한 내용', turnId: 't5' })
      expect(await line(ui, /ClickUp 동기화/)).toBeUndefined()

      await $.tool.call({ tool: 'Grep', pattern: 'a' })
      expect(await line(ui, '▶ ClickUp 동기화 해줘')).toBeDefined()
      expect(await line(ui, ' [요청]')).toBeDefined()

      await $.tool.call({ tool: 'Grep', pattern: 'b' })
      await clock.settle()
      expect(asked.filter(kind => kind === 'plan')).toHaveLength(1)
      expect(await line(ui, '☑ 설정 확인')).toBeDefined()
      expect(await line(ui, '▶ 스크립트 실행')).toBeDefined()
      expect(await line(ui, '☐ 결과 정리')).toBeDefined()
      expect(await line(ui, ' [AI 계획]')).toBeDefined()

      // Answered: the request and every step are done, with no model call.
      const before = asked.length
      await $.turn.complete(ended('t5'))
      await clock.settle()
      expect(asked).toHaveLength(before)
      expect(await line(ui, '☑ ClickUp 동기화 해줘')).toBeDefined()
      expect(await line(ui, '☑ 결과 정리')).toBeDefined()
      // The toast is for Claude's own list only.
      expect(toasts).toHaveLength(0)

      // The next turn clears the old plan and keeps the done request.
      await $.turn.start({ text: '다음 일', turnId: 't6' })
      expect(await line(ui, /결과 정리/)).toBeUndefined()
      expect(await line(ui, '☑ ClickUp 동기화 해줘')).toBeDefined()
    })

    test("Claude's own list replaces the request and the plan", async ($, on) => {
      world(on)
      const clock = mock.clock(on)
      const asked: string[] = []
      haiku(on, asked)
      on('tool.call', { tool: 'Grep' }, () => ({ result: { mode: 'files_with_matches', filenames: [], numFiles: 0 } }))
      const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })

      await $.turn.start({ text: '버그 고쳐줘', turnId: 't7' })
      await $.tool.call({ tool: 'Grep', pattern: 'a' })
      expect(await line(ui, '▶ 버그 고쳐줘')).toBeDefined()

      await $.tool.call({
        tool: 'TodoWrite',
        todos: [{ content: '원인 찾기', status: 'in_progress', activeForm: '원인 찾는 중' }],
      })
      await $.tool.call({ tool: 'Grep', pattern: 'b' })
      await clock.settle()
      expect(await line(ui, /버그 고쳐줘/)).toBeUndefined()
      expect(await line(ui, '▶ 원인 찾는 중')).toBeDefined()
      expect(asked.filter(kind => kind === 'plan')).toHaveLength(0)
    })

    test('an interrupted turn leaves its request among the items left', async ($, on) => {
      world(on)
      on('turn.complete', ($, e) => ({ text: '' }) as any)
      const clock = mock.clock(on)
      haiku(on, [])
      on('tool.call', { tool: 'Grep' }, () => ({ result: { mode: 'files_with_matches', filenames: [], numFiles: 0 } }))
      const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })

      await $.turn.start({ text: '오래 걸리는 일', turnId: 't8' })
      await $.tool.call({ tool: 'Grep', pattern: 'a' })
      await $.turn.complete(ended('t8', true))
      await clock.settle()
      expect(await line(ui, '☐ 오래 걸리는 일')).toBeDefined()
    })

    test('ignores denied and errored tool calls', async ($, on) => {
      on('tool.call', { tool: 'TaskCreate' }, () => ({ deny: 'not now' }))
      on('tool.call', { tool: 'TodoWrite' }, () => ({ isError: true, result: 'boom', text: 'boom' }))
      world(on, {}, { tools: false })
      const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })

      const denied = await $.tool.call({ tool: 'TaskCreate', subject: '거부됨', description: 'd' })
      expect(denied.deny !== undefined || denied.isError === true).toBe(true)
      const errored = await $.tool.call({
        tool: 'TodoWrite',
        todos: [{ content: '에러남', status: 'pending', activeForm: '에러 중' }],
      })
      expect(errored.isError).toBe(true)
      expect(await line(ui, EMPTY)).toBeDefined()
    })

    test('adds, groups, toggles and deletes manual items, kept in the store', async ($, on) => {
      world(on)
      const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })

      await ui.input({ key: 'add', text: '백엔드: API 정리' })
      await ui.input({ key: 'add', text: '백엔드: 로그 정리' })
      await ui.input({ key: 'add', text: '커밋하기' })
      await ui.input({ key: 'add', text: '   ' })
      expect(await linesOf(ui)).toContain('백엔드')
      expect(await line(ui, '☐ API 정리')).toBeDefined()
      expect(await line(ui, '☐ 커밋하기')).toBeDefined()
      expect(await ui.find({ key: 'toggle-4' })).toBeUndefined()
      expect(await line(ui, ' [수동] ')).toBeDefined()

      await ui.press({ key: 'toggle-1' })
      expect(await line(ui, '☑ API 정리')).toBeDefined()
      expect(await ui.find({ text: '완료 1 / 전체 3' })).toBeDefined()

      await ui.press({ key: 'done-fold' })
      expect(await ui.find({ key: 'toggle-1' })).toBeUndefined()
      await ui.press({ key: 'done-fold' })
      expect(await ui.find({ key: 'toggle-1' })).toBeDefined()

      await ui.press({ key: 'delete-2' })
      expect(await ui.find({ key: 'toggle-2' })).toBeUndefined()

      // A /clear empties the session's state; the items come back from the store.
      await $.classic.SessionStart({ source: 'clear', cwd: CWD })
      expect(await line(ui, '☑ API 정리')).toBeDefined()
      expect(await line(ui, '☐ 커밋하기')).toBeDefined()
      expect(await ui.find({ key: 'toggle-2' })).toBeUndefined()
    })

    test('restores the workspace items on SessionStart', async ($, on) => {
      world(on, {
        [`manual:${CWD}`]: [{ id: '7', section: '', text: '이전 세션 항목', done: false }],
        'manual:/elsewhere': [{ id: '1', section: '', text: '다른 워크스페이스', done: false }],
      })
      await $.classic.SessionStart({ source: 'resume', cwd: CWD })
      const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })
      expect(await line(ui, '☐ 이전 세션 항목')).toBeDefined()
      expect(await ui.find({ text: /다른 워크스페이스/ })).toBeUndefined()
    })

    test('long text wraps beside a fixed mark column, and no mark is an emoji', async ($, on) => {
      world(on)
      on('tool.call', { tool: 'Grep' }, () => ({ result: { mode: 'files_with_matches', filenames: [], numFiles: 0 } }))
      const long = '아주 긴 할 일 설명입니다. '.repeat(8).trim()
      await $.tool.call({ tool: 'TodoWrite', todos: [{ content: long, status: 'pending', activeForm: long }] })
      await $.tool.call({ tool: 'Grep', pattern: long })
      const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })
      await ui.input({ key: 'add', text: long })

      const nodes: any[] = []
      const walk = (node: any) => {
        if (node && typeof node === 'object') {
          nodes.push(node)
          ;(node.children ?? []).forEach(walk)
        }
      }
      walk(await ui.drawn())
      // Nothing is cut short with an ellipsis: every text wraps.
      expect(nodes.filter(node => String(node.props?.wrap ?? '').startsWith('truncate'))).toHaveLength(0)
      expect(await line(ui, long)).toBeDefined()
      // Every row keeps its mark in a column two cells wide that does not shrink.
      const rows = nodes.filter(node => node.type === 'Box' && String(node.props?.key ?? '').startsWith('row-'))
      expect(rows.length).toBeGreaterThan(2)
      for (const one of rows) expect(one.children[0].props).toMatchObject({ width: 2, flexShrink: 0 })
      // No emoji, whose width differs between terminals.
      expect((await linesOf(ui)).join('\n')).not.toMatch(/\p{Extended_Pictographic}/u)
    })

    test('puts the items back at the next turn when SessionStart does not arrive', async ($, on) => {
      world(on, { [`manual:${CWD}`]: [{ id: '9', section: '', text: '지난번 항목', done: false }] })
      const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })
      expect(await line(ui, '지난번 항목')).toBeUndefined()
      // No classic.SessionStart, as where an organization's plugin passes it on.
      await $.turn.start({ text: '안녕', turnId: 't9' })
      expect(await line(ui, '☐ 지난번 항목')).toBeDefined()
    })

    test('names the skills in use at the top and in the band until the turn ends', async ($, on) => {
      world(on)
      on('turn.complete', ($, e) => ({ text: '' }) as any)
      // The engine's own expansion beneath the plugin: the text it computed.
      on('skill.prompt', ($, e) => ({ text: `expanded ${e.skill}` }))
      const ui = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })
      const band = await $.ui.mount({ ...BAND, plugin: 'todo-panel', surface })
      expect(await line(ui, '스킬 사용 중')).toBeUndefined()

      await $.turn.start({ text: '/plugin-authoring', turnId: 't10' })
      const expanded = await $.skill.prompt({ skill: 'plugin-authoring', text: 'body' })
      expect(expanded.text).toBe('expanded plugin-authoring')
      await $.skill.prompt({ skill: 'code-review', text: 'body' })
      await $.skill.prompt({ skill: 'plugin-authoring', text: 'again' })

      const lines = await linesOf(ui)
      expect(lines).toContain('스킬 사용 중: code-review, plugin-authoring')
      // Right under the progress and model lines, above the lists.
      expect(lines.findIndex(one => one.startsWith('스킬 사용 중'))).toBe(lines.findIndex(one => one.startsWith('모델:')) + 1)
      await band.redraw()
      expect(await band.find({ type: 'Text', text: /^스킬: code-review, plugin-authoring · / })).toBeDefined()

      await $.turn.complete(ended('t10'))
      expect(await line(ui, '스킬 사용 중')).toBeUndefined()
      await band.redraw()
      expect(await band.find({ type: 'Text', text: /스킬:/ })).toBeUndefined()
    })

    test('the band summarises above the prompt, keeps what is below, and toggles', async ($, on) => {
      world(on)
      const band = await $.ui.mount({ ...BAND, plugin: 'todo-panel', surface })
      expect(await band.find({ type: 'Text', text: BAND_LINE })).toBeUndefined()
      expect(await band.find({ type: 'Text', text: 'downstream band' })).toBeDefined()

      await $.tool.call({
        tool: 'TodoWrite',
        todos: [
          { content: '설계', status: 'completed', activeForm: '설계 중' },
          { content: '구현', status: 'in_progress', activeForm: '구현 중' },
          { content: '검증', status: 'pending', activeForm: '검증 중' },
        ],
      })
      await band.redraw()
      expect((await band.find({ type: 'Text', text: BAND_LINE }))?.text).toBe('☑ 1/3 · 진행 중: 구현 중')
      expect(await band.find({ type: 'Text', text: 'downstream band' })).toBeDefined()

      const pane = await $.ui.mount({ ...PANE, plugin: 'todo-panel', surface })
      await pane.press({ key: 'band-toggle' })
      expect((await pane.find({ key: 'band-toggle' }))?.text).toBe('요약 띠: 꺼짐')
      await band.redraw()
      expect(await band.find({ type: 'Text', text: BAND_LINE })).toBeUndefined()
      expect(await band.find({ type: 'Text', text: 'downstream band' })).toBeDefined()

      await pane.press({ key: 'band-toggle' })
      await band.redraw()
      expect(await band.find({ type: 'Text', text: BAND_LINE })).toBeDefined()
    })
  })
}
