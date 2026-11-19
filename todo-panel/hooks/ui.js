import { atom, read, update } from 'claude-code'

/** @typedef {import('../types').ClaudeItem} ClaudeItem */
/** @typedef {import('../types').ManualItem} ManualItem */
/** @typedef {import('../types').Prefs} Prefs */
/** @typedef {import('claude-code').EngineInterface} Dollar */

export const PANE = 'todo-panel'

const TEXT_MAX = 200
const SECTION_MAX = 40
const MANUAL_MAX = 300
const BAND_MAX = 60

/** @type {ClaudeItem[]} */
const NO_CLAUDE = []
/** @type {ManualItem[]} */
const NO_MANUAL = []
/** @type {Prefs} */
const DEFAULT_PREFS = { bandOn: true, showDone: true, autoOpen: true, showActivity: true, aiReason: true, aiPlan: true }
/** @type {import('../types').ActivityItem[]} */
const NO_ACTIVITY = []

const claudeItems = atom({ plugin: 'todo-panel', key: 'claude' }, NO_CLAUDE)
const manualItems = atom({ plugin: 'todo-panel', key: 'manual' }, NO_MANUAL)
const prefsAtom = atom({ plugin: 'todo-panel', key: 'prefs' }, DEFAULT_PREFS)
const modelAtom = atom({ plugin: 'todo-panel', key: 'model' }, '')
const effortAtom = atom({ plugin: 'todo-panel', key: 'effort' }, '')
const activityAtom = atom({ plugin: 'todo-panel', key: 'activity' }, NO_ACTIVITY)
/** @type {string[]} */
const NO_SKILLS = []
const skillsAtom = atom({ plugin: 'todo-panel', key: 'skills' }, NO_SKILLS)

const ACTIVITY_SHOWN = 15

// Who put a Claude-side item up: Claude itself, the request, Haiku's plan.
const SOURCE_LABEL = { todo: 'Claude', task: 'Claude', turn: '요청', plan: 'AI 계획' }
const ACTIVITY_MARK = { running: '·', done: '✓', error: '✗' }

// C0/C1 controls, bidi overrides and zero-width marks that could break a row.
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]+/g

/**
 * Makes untrusted text safe to draw on one row: controls become spaces,
 * runs of space collapse, and the result is cut to `max` characters.
 *
 * @param {unknown} value
 * @param {number} [max]
 */
export function clean(value, max = TEXT_MAX) {
  const text = String(value ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(text)
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : text
}

const ACTIVITY_MAX = 80

/** @param {unknown} path */
const baseName = path => clean(String(path ?? '').split(/[\\/]/).filter(Boolean).pop(), 120)

/** @param {unknown} url */
const hostOf = url => {
  try {
    return clean(new URL(String(url)).host, 60)
  } catch {
    return clean(url, 60)
  }
}

/**
 * The line of Claude's text closest to the calls that follow it: its last
 * non-empty line, markdown marks taken off.
 *
 * @param {string} text
 */
export function lastLine(text) {
  const lines = text
    .split('\n')
    .map(line => line.replace(/^\s*(#+|>|[-*]|\d+\.)\s+/, '').replace(/\*\*|__|`/g, '').trim())
    .filter(line => line !== '')
  return clean(lines[lines.length - 1] ?? '', 200)
}

/**
 * One line saying what a tool call does, in the panel's words.
 *
 * @param {any} e a tool.call input
 * @returns {string}
 */
export function describeCall(e) {
  const tool = String(e.tool)
  const quote = (/** @type {unknown} */ text) => `"${clean(text, 100)}"`
  switch (tool) {
    case 'Grep':
      return `검색 ${quote(e.pattern)}${e.path ? ` · ${baseName(e.path)}` : ''}`
    case 'Glob':
      return `파일 찾기 ${clean(e.pattern, 120)}`
    case 'Read':
      return `읽기 ${baseName(e.file_path)}`
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `수정 ${baseName(e.file_path ?? e.notebook_path)}`
    case 'Bash':
    case 'PowerShell':
      return `실행 ${clean(e.description || e.command, 120)}`
    case 'WebSearch':
      return `웹 검색 ${quote(e.query)}`
    case 'WebFetch':
      return `웹 페이지 ${hostOf(e.url)}`
    case 'Agent':
      return `에이전트 ${clean(e.description || e.subagent_type, 120)}`
    case 'Skill':
      return `스킬 ${clean(e.skill, 120)}`
    case 'ToolSearch':
      return `도구 찾기 ${quote(e.query)}`
    case 'AskUserQuestion':
      return '질문하기'
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
      return mcp ? `${clean(mcp[1], 30)}: ${clean(mcp[2], 40)}` : clean(tool, ACTIVITY_MAX)
    }
  }
}

/** @param {string} cwd */
export const manualStoreKey = cwd => `manual:${cwd}`
export const PREFS_STORE_KEY = 'prefs'

/**
 * Reads the person's items for the workspace from the store, dropping
 * anything that is not a well-formed item.
 *
 * @param {Dollar} $
 * @param {string} cwd
 * @returns {Promise<ManualItem[]>}
 */
export async function loadManual($, cwd) {
  const stored = await $.store.get(manualStoreKey(cwd))
  if (!Array.isArray(stored)) return []
  return stored
    .filter(item => item && typeof item.id === 'string' && typeof item.text === 'string')
    .map(item => ({
      id: clean(item.id, 20),
      section: clean(item.section, SECTION_MAX),
      text: clean(item.text),
      done: item.done === true,
    }))
    .slice(0, MANUAL_MAX)
}

/**
 * @param {Dollar} $
 * @returns {Promise<Prefs>}
 */
export async function loadPrefs($) {
  const stored = /** @type {Partial<Prefs> | undefined} */ (await $.store.get(PREFS_STORE_KEY))
  return {
    bandOn: stored?.bandOn !== false,
    showDone: stored?.showDone !== false,
    autoOpen: stored?.autoOpen !== false,
    showActivity: stored?.showActivity !== false,
    aiReason: stored?.aiReason !== false,
    aiPlan: stored?.aiPlan !== false,
  }
}

/**
 * Applies `change` to the manual items and keeps the result for this
 * workspace across sessions.
 *
 * @param {Dollar} $
 * @param {(items: ManualItem[]) => ManualItem[]} change
 */
async function changeManual($, change) {
  const written = await update($, manualItems, items => change([...items]))
  await $.store.set(manualStoreKey(await $.session.cwd()), written)
}

/**
 * @param {Dollar} $
 * @param {(prefs: Prefs) => Prefs} change
 */
async function changePrefs($, change) {
  const written = await update($, prefsAtom, prefs => change({ ...prefs }))
  await $.store.set(PREFS_STORE_KEY, written)
}

/**
 * Splits `섹션: 내용` into its section and text; anything else has no section.
 *
 * @param {string} raw
 * @returns {{ section: string, text: string }}
 */
export function parseEntry(raw) {
  const match = /^([^:]{1,40}):\s*(.+)$/s.exec(raw.trim())
  if (match && clean(match[1], SECTION_MAX) !== '' && clean(match[2]) !== '') {
    return { section: clean(match[1], SECTION_MAX), text: clean(match[2]) }
  }
  return { section: '', text: clean(raw) }
}

/**
 * @param {Dollar} $
 * @param {string} raw
 */
async function addManual($, raw) {
  const { section, text } = parseEntry(raw)
  if (text === '') return
  await changeManual($, items => {
    const next = items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
    return [...items, { id: String(next), section, text, done: false }].slice(-MANUAL_MAX)
  })
}

/**
 * Counts for the header and the band.
 *
 * @param {readonly ClaudeItem[]} claude
 * @param {readonly ManualItem[]} manual
 */
export function tally(claude, manual) {
  const total = claude.length + manual.length
  const done =
    claude.filter(item => item.status === 'completed').length +
    manual.filter(item => item.done).length
  const active = claude.find(item => item.status === 'in_progress')
  return { total, done, active }
}

/**
 * @param {number} done
 * @param {number} total
 * @param {number} width
 */
function bar(done, total, width) {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/**
 * Groups items by their section, the unsectioned first, keeping order.
 *
 * @param {readonly ManualItem[]} items
 * @returns {[string, ManualItem[]][]}
 */
function bySection(items) {
  /** @type {Map<string, ManualItem[]>} */
  const groups = new Map([['', []]])
  for (const item of items) {
    const group = groups.get(item.section)
    if (group) group.push(item)
    else groups.set(item.section, [item])
  }
  return [...groups].filter(([, group]) => group.length > 0)
}

/**
 * Draws the panel: progress, then in progress / left / done, then the field.
 *
 * @param {Dollar} $
 * @param {import('claude-code').RenderInput<'Pane'>} e
 */
export async function renderPane($, e) {
  const table = $.ui.resolve(e)
  const { Box, Text, Button } = table
  // mobile draws no Input; the panel still shows there, read-only.
  const Input = 'Input' in table ? table.Input : undefined
  const claude = await read($, claudeItems)
  const manual = await read($, manualItems)
  const prefs = await read($, prefsAtom)
  const model = await read($, modelAtom)
  const effort = await read($, effortAtom)
  const activity = await read($, activityAtom)
  const skills = await read($, skillsAtom)
  const { total, done } = tally(claude, manual)
  const barWidth = Math.max(4, Math.min(24, e.props.bodyColumns - 24))

  /**
   * One row: a fixed column for the mark, the body beside it wrapping under
   * itself, never under the mark. Marks are one cell wide on every terminal.
   *
   * @param {string} key
   * @param {number} indent
   * @param {unknown} mark a glyph, or the element standing for it
   * @param {unknown} body
   * @param {unknown} [tail] drawn after the body, never squeezed
   */
  const row = (key, indent, mark, body, tail) =>
    h(Box, { key: `row-${key}`, flexDirection: 'row', paddingLeft: indent },
      h(Box, { width: 2, flexShrink: 0 }, typeof mark === 'string' ? h(Text, {}, mark) : mark),
      h(Box, { flexGrow: 1, flexShrink: 1 }, body),
      ...(tail ? [h(Box, { flexShrink: 0, paddingLeft: 1 }, tail)] : []))

  /** @param {ClaudeItem} item @param {string} mark */
  const claudeRow = (item, mark) => {
    const isDone = item.status === 'completed'
    return row(`c-${item.id}`, 2, h(Text, { dimColor: isDone, color: isDone ? 'success' : undefined }, mark),
      h(Text, { dimColor: isDone, strikethrough: isDone, wrap: 'wrap' },
        item.status === 'in_progress' ? item.activeForm || item.content : item.content,
        h(Text, { dimColor: true, strikethrough: false }, ` [${SOURCE_LABEL[item.source]}]`)))
  }

  /** @param {ManualItem} item @param {number} indent */
  const manualRow = (item, indent) =>
    row(`m-${item.id}`, indent,
      h(Button, {
        key: `toggle-${item.id}`,
        plain: true,
        label: item.done ? '☑' : '☐',
        onPress: () => changeManual($, items =>
          items.map(one => (one.id === item.id ? { ...one, done: !one.done } : one))),
      }),
      h(Text, { dimColor: item.done, strikethrough: item.done, wrap: 'wrap' },
        item.text,
        h(Text, { dimColor: true, strikethrough: false }, ' [수동] ')),
      h(Button, {
        key: `delete-${item.id}`,
        label: '삭제',
        dimColor: true,
        onPress: () => changeManual($, items => items.filter(one => one.id !== item.id)),
      }))

  /** @param {readonly ManualItem[]} items @param {string} scope */
  const manualGroups = (items, scope) =>
    bySection(items).flatMap(([section, group]) =>
      section === ''
        ? group.map(item => manualRow(item, 2))
        : [
            h(Box, { key: `section-${scope}-${section}`, paddingLeft: 2 },
              h(Text, { bold: true, wrap: 'wrap' }, section)),
            ...group.map(item => manualRow(item, 4)),
          ])

  /** @param {string} key @param {string} title @param {number} count */
  const heading = (key, title, count) =>
    h(Box, { key, marginTop: 1 }, h(Text, { bold: true }, `${title} (${count})`))

  /**
   * A heading that folds the block under it.
   *
   * @param {string} key @param {string} title @param {number} count
   * @param {boolean} isOpen @param {() => unknown} toggle
   */
  const foldHeading = (key, title, count, isOpen, toggle) =>
    h(Box, { key: `${key}-box`, marginTop: 1 },
      h(Button, { key, plain: true, onPress: toggle }, `${isOpen ? '▾' : '▸'} ${title} (${count})`))

  const running = claude.filter(item => item.status === 'in_progress')
  const leftClaude = claude.filter(item => item.status === 'pending')
  const leftManual = manual.filter(item => !item.done)
  const doneClaude = claude.filter(item => item.status === 'completed')
  const doneManual = manual.filter(item => item.done)
  const doneCount = doneClaude.length + doneManual.length

  /** @param {string} key @param {string} label @param {boolean} isOn @param {(prefs: Prefs) => Prefs} flip */
  const setting = (key, label, isOn, flip) =>
    h(Button, { key, label: `${label}: ${isOn ? '켜짐' : '꺼짐'}`, dimColor: true, onPress: () => changePrefs($, flip) })

  // Consecutive calls Claude explained with one line sit under it; a reason
  // Haiku wrote for a single call goes on the row below that call.
  const activityRows = activity.slice(-ACTIVITY_SHOWN).flatMap((item, index, shown) => {
    const isClaudes = item.whyBy === 'claude'
    const previous = shown[index - 1]
    const isNewReason = isClaudes && item.why !== (previous?.whyBy === 'claude' ? previous.why : '')
    const markColor = item.status === 'error' ? 'error' : item.status === 'done' ? 'success' : undefined
    return [
      ...(isNewReason ? [row(`why-${item.id}`, 2, '»', h(Text, { italic: true, wrap: 'wrap' }, item.why))] : []),
      row(`a-${item.id}`, isClaudes ? 4 : 2,
        h(Text, { color: markColor }, ACTIVITY_MARK[item.status]),
        h(Text, { dimColor: item.status === 'done', color: item.status === 'error' ? 'error' : undefined, wrap: 'wrap' }, item.text)),
      ...(item.whyBy === 'ai' && item.why
        ? [row(`ai-${item.id}`, isClaudes ? 6 : 4, h(Text, { dimColor: true }, '↳'), h(Text, { dimColor: true, wrap: 'wrap' }, item.why))]
        : []),
    ]
  })

  return h(Box, { flexDirection: 'column' },
    h(Box, { key: 'header' },
      h(Text, { color: 'success' }, bar(done, total, barWidth)),
      h(Text, { bold: true }, ` 완료 ${done} / 전체 ${total}`)),
    h(Text, { key: 'model', dimColor: true, wrap: 'wrap' }, `모델: ${model || '확인 중'}${effort ? ` · effort: ${effort}` : ''}`),
    ...(skills.length > 0
      ? [h(Text, { key: 'skills', wrap: 'wrap' },
          h(Text, { bold: true, color: 'warning' }, '스킬 사용 중: '),
          skills.join(', '))]
      : []),
    total === 0
      ? h(Box, { key: 'empty', marginTop: 1 },
          h(Text, { dimColor: true, wrap: 'wrap' },
            '할 일이 없습니다. Claude가 작업 목록을 만들면 여기에 나타나고, 아래 입력창으로 직접 추가할 수도 있습니다.'))
      : h(Box, { key: 'lists', flexDirection: 'column' },
          heading('running-heading', '진행 중', running.length),
          ...running.map(item => claudeRow(item, '▶')),
          heading('left-heading', '남은 일', leftClaude.length + leftManual.length),
          ...leftClaude.map(item => claudeRow(item, '☐')),
          ...manualGroups(leftManual, 'left'),
          foldHeading('done-fold', '완료', doneCount, prefs.showDone,
            () => changePrefs($, one => ({ ...one, showDone: !one.showDone }))),
          ...(prefs.showDone
            ? [...doneClaude.map(item => claudeRow(item, '☑')), ...manualGroups(doneManual, 'done')]
            : [])),
    Input
      ? h(Box, { key: 'add-box', marginTop: 1 },
          h(Input, {
            key: 'add',
            placeholder: '할 일 추가 (섹션: 내용)',
            submitLabel: '추가',
            value: '',
            onSubmit: (/** @type {string} */ value) => addManual($, value),
          }))
      : h(Text, { key: 'no-input', dimColor: true, wrap: 'wrap' }, '이 화면에서는 할 일을 추가할 수 없습니다.'),
    h(Box, { key: 'activity', flexDirection: 'column' },
      foldHeading('activity-fold', '탐색 과정', activity.length, prefs.showActivity,
        () => changePrefs($, one => ({ ...one, showActivity: !one.showActivity }))),
      ...(!prefs.showActivity
        ? []
        : activity.length === 0
          ? [h(Box, { key: 'activity-empty', paddingLeft: 2 }, h(Text, { dimColor: true, wrap: 'wrap' }, '이번 턴에 사용한 도구가 없습니다.'))]
          : [
              ...(activity.length > ACTIVITY_SHOWN
                ? [h(Box, { key: 'activity-more', paddingLeft: 2 }, h(Text, { dimColor: true }, `앞의 ${activity.length - ACTIVITY_SHOWN}개 생략`))]
                : []),
              ...activityRows,
            ])),
    h(Box, { key: 'settings', flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, marginTop: 1 },
      h(Text, { dimColor: true }, '설정'),
      setting('band-toggle', '요약 띠', prefs.bandOn, one => ({ ...one, bandOn: !one.bandOn })),
      setting('auto-open-toggle', '시작 시 열기', prefs.autoOpen, one => ({ ...one, autoOpen: !one.autoOpen })),
      setting('ai-reason-toggle', 'AI 설명(Haiku)', prefs.aiReason, one => ({ ...one, aiReason: !one.aiReason })),
      setting('ai-plan-toggle', 'AI 계획(Haiku)', prefs.aiPlan, one => ({ ...one, aiPlan: !one.aiPlan }))))
}

/**
 * The one-line summary drawn above the prompt, or null when there is none.
 *
 * @param {Dollar} $
 */
export async function bandLine($) {
  const prefs = await read($, prefsAtom)
  if (!prefs.bandOn) return null
  const { total, done, active } = tally(await read($, claudeItems), await read($, manualItems))
  const skills = await read($, skillsAtom)
  if (total === 0 && skills.length === 0) return null
  const parts = [
    ...(total > 0 ? [`☑ ${done}/${total}`] : []),
    ...(active ? [`진행 중: ${clean(active.activeForm || active.content, BAND_MAX)}`] : []),
    ...(skills.length > 0 ? [`스킬: ${skills.join(', ')}`] : []),
  ]
  const model = await read($, modelAtom)
  const effort = await read($, effortAtom)
  const modelPart = model && effort ? `${model} (${effort})` : model
  return [...parts, ...(modelPart ? [modelPart] : [])].join(' · ')
}
