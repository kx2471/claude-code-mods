import { atom, read, update } from 'claude-code'

import { clean } from './ui.js'

/** @typedef {import('../types').ActivityItem} ActivityItem */
/** @typedef {import('../types').ClaudeItem} ClaudeItem */
/** @typedef {import('../types').TodoStatus} TodoStatus */
/** @typedef {import('../types').TurnInfo} TurnInfo */
/** @typedef {import('claude-code').EngineInterface} Dollar */

/** @type {ClaudeItem[]} */
const NO_CLAUDE = []
/** @type {ActivityItem[]} */
const NO_ACTIVITY = []
/** @type {TurnInfo} */
const NO_TURN = { id: '', calls: 0, hasClaudeList: false, isPlanAsked: false }
const claudeItems = atom({ plugin: 'todo-panel', key: 'claude' }, NO_CLAUDE)
const activityAtom = atom({ plugin: 'todo-panel', key: 'activity' }, NO_ACTIVITY)
const turnPromptAtom = atom({ plugin: 'todo-panel', key: 'turnPrompt' }, '')
const turnAtom = atom({ plugin: 'todo-panel', key: 'turn' }, NO_TURN)
const prefsAtom = atom(
  { plugin: 'todo-panel', key: 'prefs' },
  { bandOn: true, showDone: true, autoOpen: true, showActivity: true, aiReason: true, aiPlan: true },
)

// Past requests kept as done items; older ones leave.
const TURNS_KEPT = 10
// Haiku is asked to tick the plan after this many calls, and at the turn's end.
const CHECK_EVERY = 3

const PLAN_SYSTEM =
  'Claude Code가 사용자 요청을 처리하는 과정을 옆 패널에 할 일로 보여줍니다. 요청과 지금까지의 ' +
  '도구 호출을 보고, 남은 일까지 포함한 전체 작업을 3~5단계로 나눕니다. 각 줄을 "- 단계" ' +
  '형식으로, 한국어 25자 이내로 쓰고 다른 말은 쓰지 않습니다.'

const CHECK_SYSTEM =
  '작업 단계 목록과 지금까지 실행한 도구 호출 기록을 보고 진행 상황을 판단합니다. ' +
  '정확히 두 줄로 답합니다. 첫 줄 "완료: 번호,번호" (없으면 "완료: 없음"), ' +
  '둘째 줄 "진행: 번호" (없으면 "진행: 없음").'

const turnItemId = (/** @type {string} */ turnId) => `turn-${turnId}`

/** @param {string} prompt */
const requestTitle = prompt => clean(prompt.split('\n').find(line => line.trim() !== '') ?? '', 60) || '요청 처리'

/**
 * Starts a turn of the main conversation: the last turn's plan goes, its
 * request stays among the done items.
 *
 * @param {Dollar} $
 * @param {string} turnId
 */
export async function startTurn($, turnId) {
  await update($, turnAtom, () => ({ id: turnId, calls: 0, hasClaudeList: false, isPlanAsked: false }))
  await update($, claudeItems, items => {
    const kept = items.filter(item => item.source !== 'plan')
    const turns = kept.filter(item => item.source === 'turn')
    const dropped = new Set(turns.slice(0, Math.max(0, turns.length - TURNS_KEPT + 1)).map(item => item.id))
    return kept.filter(item => !dropped.has(item.id))
  })
}

/**
 * Claude made its own list: that is the plan, so this turn's request item
 * and Haiku's steps step aside.
 *
 * @param {Dollar} $
 */
export async function claudeListed($) {
  const turn = await read($, turnAtom)
  if (turn.hasClaudeList) return
  await update($, turnAtom, one => ({ ...one, hasClaudeList: true }))
  await update($, claudeItems, items =>
    items.filter(item => item.source !== 'plan' && item.id !== turnItemId(turn.id)))
}

/**
 * Counts a tool call of the turn: the first puts the request up as a todo,
 * the second asks Haiku for a plan when Claude has made no list.
 *
 * @param {Dollar} $
 * @param {(fn: () => void) => void} later runs `fn` after this call went on
 */
export async function countCall($, later) {
  const turn = await update($, turnAtom, one => ({ ...one, calls: one.calls + 1 }))
  if (turn.hasClaudeList || turn.id === '') return
  if (turn.calls === 1) {
    const title = requestTitle(await read($, turnPromptAtom))
    await update($, claudeItems, items => [
      ...items.filter(item => item.id !== turnItemId(turn.id)),
      { id: turnItemId(turn.id), source: 'turn', content: title, activeForm: title, status: 'in_progress' },
    ])
  }
  const prefs = await read($, prefsAtom)
  if (!prefs.aiPlan) return
  if (turn.calls === 2 && !turn.isPlanAsked) {
    await update($, turnAtom, one => ({ ...one, isPlanAsked: true }))
    later(() => void makePlan($, turn.id))
  } else if (turn.calls > 2 && turn.calls % CHECK_EVERY === 0) {
    later(() => void checkPlan($, false))
  }
}

/**
 * Ends a turn. Answered, its request and every step are done, no model asked.
 * Interrupted, the request goes back to the items left and Haiku says how far
 * the plan got.
 *
 * @param {Dollar} $
 * @param {string} turnId
 * @param {boolean} isAborted
 * @param {(fn: () => void) => void} later
 */
export async function finishTurn($, turnId, isAborted, later) {
  /** @type {TodoStatus} */
  const status = isAborted ? 'pending' : 'completed'
  await update($, claudeItems, items =>
    items.map(item =>
      item.id === turnItemId(turnId) || (!isAborted && item.source === 'plan') ? { ...item, status } : item))
  const items = await read($, claudeItems)
  if (isAborted && items.some(item => item.source === 'plan')) later(() => void checkPlan($, true))
}

/** @param {readonly ActivityItem[]} activity */
const callLog = activity =>
  activity.map((item, index) => `${index + 1}. ${item.text}${item.why ? ` (${item.why})` : ''}`).join('\n') || '(없음)'

/**
 * Asks Haiku to split the turn's request into steps and puts them up.
 *
 * @param {Dollar} $
 * @param {string} turnId
 */
async function makePlan($, turnId) {
  try {
    const prompt = `사용자 요청: ${clean(await read($, turnPromptAtom), 300) || '(없음)'}\n지금까지의 도구 호출:\n${callLog(await read($, activityAtom))}`
    const answer = await $.model.complete({ model: 'haiku', system: PLAN_SYSTEM, prompt, maxTokens: 200, timeoutMs: 20000 })
    if (!answer.isAnswered) return
    const steps = answer.text
      .split('\n')
      .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ''))
      .map(line => clean(line, 40))
      .filter(line => line !== '')
      .slice(0, 5)
    const turn = await read($, turnAtom)
    // The turn moved on, or Claude made its own list meanwhile.
    if (steps.length === 0 || turn.id !== turnId || turn.hasClaudeList) return
    await update($, claudeItems, items => [
      ...items.filter(item => item.source !== 'plan'),
      ...steps.map((step, index) => ({
        id: `plan-${turnId}-${index}`,
        source: /** @type {const} */ ('plan'),
        content: step,
        activeForm: step,
        status: /** @type {TodoStatus} */ (index === 0 ? 'in_progress' : 'pending'),
      })),
    ])
    await checkPlan($, false)
  } catch {
    // No plan: the request item still stands for the turn.
  }
}

// One check at a time; a check asked for meanwhile runs once after it.
let isChecking = false
let isCheckWanted = false
let isFinalWanted = false

/**
 * Asks Haiku which steps the calls so far have done, and ticks them. A step
 * once done stays done.
 *
 * @param {Dollar} $
 * @param {boolean} isFinal the person interrupted the turn
 */
async function checkPlan($, isFinal) {
  if (isChecking) {
    isCheckWanted = true
    isFinalWanted ||= isFinal
    return
  }
  isChecking = true
  try {
    const plan = (await read($, claudeItems)).filter(item => item.source === 'plan')
    if (plan.length === 0) return
    const prompt = [
      `작업 단계:\n${plan.map((item, index) => `${index + 1}. ${item.content}`).join('\n')}`,
      `실행한 도구 호출:\n${callLog(await read($, activityAtom))}`,
      isFinal ? '사용자가 작업을 중단했습니다. 진행 중인 단계는 없습니다.' : '작업은 아직 진행 중입니다.',
    ].join('\n\n')
    const answer = await $.model.complete({ model: 'haiku', system: CHECK_SYSTEM, prompt, maxTokens: 40, timeoutMs: 20000 })
    if (!answer.isAnswered) return
    const numbers = (/** @type {string} */ label) => {
      const line = answer.text.split('\n').find(one => one.includes(label)) ?? ''
      return new Set((line.match(/\d+/g) ?? []).map(Number).filter(n => n >= 1 && n <= plan.length))
    }
    const done = numbers('완료')
    const [current] = [...numbers('진행')]
    const ids = plan.map(item => item.id)
    await update($, claudeItems, items =>
      items.map(item => {
        const at = ids.indexOf(item.id) + 1
        if (at === 0 || item.status === 'completed') return item
        /** @type {TodoStatus} */
        const status = done.has(at) ? 'completed' : at === current && !isFinal ? 'in_progress' : 'pending'
        return { ...item, status }
      }))
  } catch {
    // The plan stays as it was.
  } finally {
    isChecking = false
    if (isCheckWanted) {
      const final = isFinalWanted
      isCheckWanted = false
      isFinalWanted = false
      await checkPlan($, final)
    }
  }
}
