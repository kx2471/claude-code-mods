import { atom, read, update } from 'claude-code'

import { claudeListed, countCall, finishTurn, startTurn } from './plan.js'
import { PANE, bandLine, clean, describeCall, lastLine, loadManual, loadPrefs, renderPane, tally } from './ui.js'

/** @typedef {import('../types').ActivityItem} ActivityItem */
/** @typedef {import('../types').ClaudeItem} ClaudeItem */
/** @typedef {import('../types').ManualItem} ManualItem */
/** @typedef {import('../types').TodoStatus} TodoStatus */
/** @typedef {import('claude-code').EngineInterface} Dollar */

// The same values ui.js draws from; each file names the ones it writes.
/** @type {ClaudeItem[]} */
const NO_CLAUDE = []
/** @type {ManualItem[]} */
const NO_MANUAL = []
const claudeItems = atom({ plugin: 'todo-panel', key: 'claude' }, NO_CLAUDE)
const manualItems = atom({ plugin: 'todo-panel', key: 'manual' }, NO_MANUAL)
const prefsAtom = atom(
  { plugin: 'todo-panel', key: 'prefs' },
  { bandOn: true, showDone: true, autoOpen: true, showActivity: true, aiReason: true, aiPlan: true },
)
const modelAtom = atom({ plugin: 'todo-panel', key: 'model' }, '')
const effortAtom = atom({ plugin: 'todo-panel', key: 'effort' }, '')
/** @type {ActivityItem[]} */
const NO_ACTIVITY = []
const activityAtom = atom({ plugin: 'todo-panel', key: 'activity' }, NO_ACTIVITY)
const narrationAtom = atom({ plugin: 'todo-panel', key: 'narration' }, '')
const turnPromptAtom = atom({ plugin: 'todo-panel', key: 'turnPrompt' }, '')
const restoredForAtom = atom({ plugin: 'todo-panel', key: 'restoredFor' }, '')
/** @type {string[]} */
const NO_SKILLS = []
const skillsAtom = atom({ plugin: 'todo-panel', key: 'skills' }, NO_SKILLS)

const REASON_SYSTEM =
  'Claude Code 세션 옆 패널에 들어갈 한 줄 설명을 씁니다. 주어진 도구 호출이 무엇을 하고 ' +
  '왜 하는지를 한국어 한 문장, 40자 이내로 씁니다. 따옴표, 마침표, 머리말 없이 설명만 씁니다.'

/**
 * What Haiku is told about one call: the turn's request, the steps just
 * before it, and the call itself. Long inputs (a file's content) stay out.
 *
 * @param {any} e a tool.call input
 * @param {string} text the call as the panel names it
 * @param {string} prompt the person's prompt for this turn
 * @param {readonly ActivityItem[]} before the turn's earlier calls
 */
function reasonPrompt(e, text, prompt, before) {
  const detail = clean(e.command ?? e.pattern ?? e.query ?? e.url ?? e.file_path ?? e.prompt ?? '', 200)
  return [
    `사용자 요청: ${clean(prompt, 300) || '(없음)'}`,
    `직전 단계: ${before.slice(-3).map(item => item.text).join(' → ') || '(없음)'}`,
    `이번 호출: ${text}`,
    detail ? `세부: ${detail}` : '',
  ].filter(Boolean).join('\n')
}

/**
 * Asks Haiku why a call was made and writes the line on its row. Runs from a
 * timer, after the call went on, so the call never waits for it; a reply that
 * does not come leaves the row as it is.
 *
 * @param {Dollar} $
 * @param {string} id the row's id
 * @param {string} prompt
 */
async function explain($, id, prompt) {
  try {
    const answer = await $.model.complete({
      model: 'haiku',
      system: REASON_SYSTEM,
      prompt,
      maxTokens: 80,
      timeoutMs: 20000,
    })
    if (!answer.isAnswered) return
    const why = lastLine(answer.text).replace(/[.。]$/, '')
    if (why === '') return
    await update($, activityAtom, items =>
      items.map(item => (item.id === id && item.why === '' ? { ...item, why, whyBy: /** @type {const} */ ('ai') } : item)))
  } catch {
    // The reason is a nicety: the row stays without one.
  }
}

const ACTIVITY_KEEP = 100

// Already shown as todos, so not repeated as activity.
const TODO_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'mcp__usage-band__checklist'])

/**
 * Keeps the session's model in state, writing only when it changed so the
 * panel and band redraw only then.
 *
 * @param {Dollar} $
 * @param {string} [known] the model when the event already names it
 */
async function refreshModel($, known) {
  const model = clean(known ?? (await $.session.model()), 80)
  if (model !== '' && model !== (await read($, modelAtom))) {
    await update($, modelAtom, () => model)
  }
}

/**
 * @param {unknown} status
 * @returns {TodoStatus}
 */
const toStatus = status =>
  status === 'completed' || status === 'in_progress' ? status : 'pending'

/**
 * Registers the command and puts the person's items for this workspace back
 * into the session's state, which starts empty after /clear, /resume, /branch.
 *
 * @param {Dollar} $
 * @param {string} cwd
 */
async function setUp($, cwd) {
  await $.command.register({
    name: 'todo-panel',
    description: '이번 세션의 할 일 패널을 엽니다 (Esc로 닫기)',
  })
  const manual = await loadManual($, cwd)
  const prefs = await loadPrefs($)
  await update($, manualItems, () => manual)
  await update($, prefsAtom, () => prefs)
  await update($, restoredForAtom, () => cwd)
  await refreshModel($)
}

/**
 * Whether Claude itself put the item up, not the panel on its behalf.
 *
 * @param {ClaudeItem} item
 */
const isClaudesOwn = item => item.source === 'todo' || item.source === 'task'

/**
 * Runs `fn` once the current dispatch has gone on, from a timer; where no
 * timer can be set, it is left undone.
 *
 * @param {Dollar} $
 */
const laterOn = $ => (/** @type {() => void} */ fn) => {
  try {
    $.clock.after(0, fn)
  } catch {
    // A nicety left out.
  }
}

/**
 * Applies `change` to Claude's items and says so once they are all done.
 *
 * @param {Dollar} $
 * @param {(items: ClaudeItem[]) => ClaudeItem[]} change
 */
async function changeClaude($, change) {
  const before = (await read($, claudeItems)).filter(isClaudesOwn)
  const after = (await update($, claudeItems, items => change([...items]))).filter(isClaudesOwn)
  const wasOpen = before.some(item => item.status !== 'completed')
  const { total, done } = tally(after, [])
  if (wasOpen && total > 0 && done === total) {
    $.ui.toast(`Claude의 할 일 ${total}개를 모두 마쳤습니다.`)
  }
}

/**
 * Puts a whole-list update (TodoWrite, usage-band's checklist) in place of
 * the previous one, leaving Task items alone.
 *
 * @param {Dollar} $
 * @param {readonly any[]} todos
 */
const replaceTodos = async ($, todos) => {
  if (todos.length > 0) await claudeListed($)
  await changeClaude($, items => [
    ...items.filter(item => item.source !== 'todo'),
    ...todos.slice(0, 200).map((todo, index) => ({
      id: `todo-${index}`,
      source: /** @type {const} */ ('todo'),
      content: clean(todo.content),
      activeForm: clean(todo.activeForm),
      status: toStatus(todo.status),
    })),
  ])
}

/**
 * Whether the call went through: neither refused nor errored.
 *
 * @param {import('claude-code').ToolCallResult} ran
 */
const isApplied = ran => ran.deny === undefined && ran.isError !== true

/** @type {import('claude-code').Register} */
export const register = on => {
  on('session.start', async ($, e, next) => {
    await setUp($, e.cwd)
    // Opened at start when the person asked for it in the panel (on by
    // default). Unasked, a terminal seats it once wide enough; until then it waits.
    if ((await read($, prefsAtom)).autoOpen) {
      void $.ui.open({ id: PANE, title: 'Todo', closeOnEscape: true })
    }
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      await update($, claudeItems, () => [])
      await update($, skillsAtom, () => [])
    }
    await setUp($, e.cwd)
    return next(e)
  }).catch(($, e, next) => next(e))

  // /model mid-session names the new model; a turn start also re-reads it, which
  // covers any switch that raises no settings hook.
  on('classic.PostModelSwitch', async ($, e, next) => {
    await refreshModel($, e.to_model)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A turn of the main conversation starts a fresh activity list; until then
  // the last turn's stays up.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      // Where classic.SessionStart does not reach this plugin (an organization's
      // plugin can send it on past the ones a person installs), the state a
      // /clear emptied is filled back here, at the next turn.
      const cwd = await $.session.cwd()
      if ((await read($, restoredForAtom)) !== cwd) await setUp($, cwd)
      await update($, activityAtom, () => [])
      await update($, narrationAtom, () => '')
      await update($, turnPromptAtom, () => clean(e.text, 300))
      await startTurn($, e.turnId)
      await refreshModel($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await finishTurn($, e.turnId, e.isAborted, laterOn($))
      // The skills were in use for this turn; once it ends, none is.
      await update($, skillsAtom, () => [])
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The effort each request of the main loop asks for (after /effort, the
  // model's own levels and any cap): read as the request goes out, which is
  // sent on unchanged and streamed back as it came.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      try {
        const effort = e.effort === undefined ? '' : clean(String(e.effort), 20)
        if (effort !== (await read($, effortAtom))) await update($, effortAtom, () => effort)
      } catch {
        // Only a label: the request goes on without it.
      }
    }
    return yield* next(e)
  })

  // A skill in use: the engine expands its prompt for the model whether the
  // person typed /name or Claude called the Skill tool. Watch only: the text
  // the model reads is what the plugins beneath computed, returned unchanged.
  on('skill.prompt', async ($, e, next) => {
    const expanded = await next(e)
    const name = clean(e.skill, 60)
    if (name !== '') {
      await update($, skillsAtom, names => [...names.filter(one => one !== name), name].slice(-5))
    }
    return expanded
  }).catch(($, e, next) => next(e))

  // What Claude writes before its calls is why it makes them: keep the last
  // line of each response text in the main conversation for the calls that
  // follow. Watch only: the row is stored as it came.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId !== undefined || e.message.role !== 'assistant') return stored
    const said = e.message.content
      .map(block => (block.type === 'text' ? String(/** @type {any} */ (block).text ?? '') : ''))
      .join('\n')
    const line = lastLine(said)
    if (line !== '') await update($, narrationAtom, () => line)
    return stored
  }).catch(($, e, next) => next(e))

  // Once a call's result is in, Claude's last line has been used up: the next
  // message's calls get it only if Claude writes a new one.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined) await update($, narrationAtom, () => '')
    return stored
  }).catch(($, e, next) => next(e))

  // Every tool call Claude makes in the main conversation, as it runs and
  // how it ended. Watch only: the call goes on unchanged, its result returned.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || TODO_TOOLS.has(String(e.tool))) return next(e)
    const id = e.tool_use_id || `call-${(await read($, activityAtom)).length}`
    const text = describeCall(e)
    const why = await read($, narrationAtom)
    const before = await read($, activityAtom)
    await update($, activityAtom, items =>
      [
        ...items.filter(item => item.id !== id),
        {
          id,
          text,
          why,
          whyBy: why ? /** @type {const} */ ('claude') : /** @type {const} */ (''),
          status: /** @type {const} */ ('running'),
        },
      ].slice(-ACTIVITY_KEEP))
    await countCall($, laterOn($))
    if (why === '' && (await read($, prefsAtom)).aiReason) {
      const prompt = reasonPrompt(e, text, await read($, turnPromptAtom), before)
      laterOn($)(() => void explain($, id, prompt))
    }
    const ran = await next(e)
    const status = ran.deny !== undefined || ran.isError === true ? 'error' : 'done'
    await update($, activityAtom, items =>
      items.map(item => (item.id === id ? { ...item, status } : item)))
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'todo-panel' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Todo', focus: true, closeOnEscape: true })
    return {
      text: opened.isPlaced ? '할 일 패널을 열었습니다.' : '할 일 패널을 열었습니다. 화면이 생기면 표시됩니다.',
    }
  })

  // The tool hooks only watch: each passes the call on unchanged and returns
  // what ran. The .catch replays that same result if the bookkeeping throws.

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    // A subagent's TodoWrite is its own list, not this session's.
    if (!isApplied(ran) || e.agentId !== undefined) return ran
    /** @type {any} */
    const result = ran.result
    await replaceTodos($, Array.isArray(result?.newTodos) ? result.newTodos : e.todos)
    return ran
  }).catch(($, e, next) => next(e))

  // usage-band's own checklist tool answers its calls itself, so whether a
  // tool.call hook here sees them depends on the plugins' order. Its write of
  // the list to its state does reach every plugin: watch that, pass it on
  // unchanged. It holds the same whole list TodoWrite would.
  on('state.set', { plugin: 'usage-band', key: 'todos' }, async ($, e, next) => {
    const written = await next(e)
    /** @type {unknown} */
    const value = e.value
    // A hook on a call of $ sees its answer wrapped: { value } or { deny }.
    /** @type {any} */
    const answer = written
    if (answer?.value?.isSet !== true || !Array.isArray(value)) return written
    await replaceTodos($, value.map(todo => ({
      content: todo?.text,
      activeForm: todo?.activeText,
      status: todo?.status,
    })))
    return written
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (!isApplied(ran)) return ran
    /** @type {any} */
    const result = ran.result
    const task = result?.task
    if (typeof task?.id !== 'string' && typeof task?.id !== 'number') return ran
    const id = `task-${clean(task.id, 40)}`
    if (e.agentId === undefined) await claudeListed($)
    await changeClaude($, items => [
      ...items.filter(item => item.id !== id),
      {
        id,
        source: 'task',
        content: clean(task.subject ?? e.subject),
        activeForm: clean(e.activeForm ?? ''),
        status: 'pending',
      },
    ].slice(-200))
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (!isApplied(ran)) return ran
    /** @type {any} */
    const result = ran.result
    if (result?.success === false) return ran
    const id = `task-${clean(e.taskId, 40)}`
    if (e.status === 'deleted') {
      await changeClaude($, items => items.filter(item => item.id !== id))
      return ran
    }
    await changeClaude($, items => {
      const known = items.find(item => item.id === id)
      const base = known ?? {
        id,
        source: /** @type {const} */ ('task'),
        content: `작업 #${clean(e.taskId, 40)}`,
        activeForm: '',
        status: /** @type {TodoStatus} */ ('pending'),
      }
      const changed = {
        ...base,
        content: e.subject !== undefined ? clean(e.subject) : base.content,
        activeForm: e.activeForm !== undefined ? clean(e.activeForm) : base.activeForm,
        status: e.status !== undefined ? toStatus(e.status) : base.status,
      }
      return known ? items.map(item => (item.id === id ? changed : item)) : [...items, changed]
    })
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: 'todo-panel' }, ($, e) => renderPane($, e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const line = await bandLine($)
    if (line === null) return below
    const { Box, Text } = $.ui.resolve(e)
    return h(Box, { flexDirection: 'column' },
      h(Text, { key: 'todo-band', dimColor: true, wrap: 'truncate-end' }, line),
      below)
  })
}
