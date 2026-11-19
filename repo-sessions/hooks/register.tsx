import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PaneData, PaneRow } from '../types'
import {
  ACTIVE_MS,
  asciiJson,
  displayTitle,
  displayWidth,
  fitWidth,
  formatListing,
  isEmpty,
  matchesKeyword,
  normPath,
  parseWorktrees,
  projectDirName,
  resumeArg,
  selectProjectDirs,
  toRow,
  type ProjectDir,
  type ScanRecord,
  type Session,
  type Worktree,
} from './lib'

const COMMAND = 'sessions'
const LIMIT = 20
const PANE = 'repo-sessions'
const pane = atom({ plugin: 'repo-sessions', key: 'pane' } as const, null)

// Scanned metadata per transcript, reused while the file's size and mtime stand still.
const cache = new Map<string, { size: number; mtimeMs: number; rec: ScanRecord }>()

type Found = { repoName: string; worktrees: Worktree[]; sessions: Session[] }

async function projectsRoot($: EngineInterface): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  if (config) return `${config.replace(/[\\/]+$/, '')}\\projects`
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  return `${home.replace(/[\\/]+$/, '')}\\.claude\\projects`
}

async function listWorktrees($: EngineInterface, cwd: string): Promise<Worktree[]> {
  try {
    const run = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { cwd, timeoutMs: 15000 })
    if (run.exitCode === 0) return parseWorktrees(run.stdout)
  } catch {
    // git missing or failed: fall back to the session's own directory below
  }
  return []
}

async function scan($: EngineInterface, files: string[]): Promise<ScanRecord[]> {
  if (files.length === 0) return []
  const script = `${$.plugin.root}/scripts/scan-sessions.ps1`.replace(/\//g, '\\')
  const argv = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
  try {
    const run = await $.process.run(argv, { stdin: asciiJson({ files }), timeoutMs: 120000 })
    const parsed: unknown = JSON.parse(run.stdout || 'null')
    if (Array.isArray(parsed)) return parsed as ScanRecord[]
    const why = (parsed as { fatal?: string } | null)?.fatal ?? (run.stderr.trim() || `exit ${run.exitCode}`)
    return files.map(path => ({ path, error: `스캔 실패: ${why}` }))
  } catch (err) {
    return files.map(path => ({ path, error: `스캔 실패: ${String(err)}` }))
  }
}

async function findSessions($: EngineInterface): Promise<Found> {
  const cwd = await $.session.cwd()
  let worktrees = await listWorktrees($, cwd)
  if (worktrees.length === 0) worktrees = [{ path: cwd, branch: null }]

  const root = await projectsRoot($)
  const dirNames = (await $.fs.list(root)).filter(e => e.kind === 'dir').map(e => e.name)
  const dirs = selectProjectDirs(dirNames, worktrees)

  const entries: { dir: ProjectDir; file: string; id: string; size: number; mtimeMs: number }[] = []
  for (const dir of dirs) {
    const listed = await $.fs.list(`${root}\\${dir.name}`).catch(() => [])
    for (const e of listed) {
      if (e.kind !== 'file' || !e.name.endsWith('.jsonl')) continue
      entries.push({ dir, file: `${root}\\${dir.name}\\${e.name}`, id: e.name.slice(0, -6), size: e.size, mtimeMs: e.mtimeMs })
    }
  }

  const stale = entries.filter(e => {
    const hit = cache.get(e.file)
    return !hit || hit.size !== e.size || hit.mtimeMs !== e.mtimeMs
  })
  const fresh = await scan($, stale.map(e => e.file))
  const byPath = new Map(fresh.map(r => [normPath(r.path ?? ''), r]))
  for (const e of stale) {
    const rec = byPath.get(normPath(e.file)) ?? { path: e.file, error: '스캔 결과 없음' }
    if (!rec.error) cache.set(e.file, { size: e.size, mtimeMs: e.mtimeMs, rec })
    else cache.delete(e.file)
    byPath.set(normPath(e.file), rec)
  }

  const missing = new Map<string, boolean>()
  for (const dir of dirs) {
    if (dir.path && !missing.has(dir.path)) missing.set(dir.path, !(await $.fs.exists(dir.path)))
  }

  // Several working directories (Sample_App, Sample-App) share one project directory name;
  // keep a session only when its recorded cwd, if any, lies inside one of this repository's worktrees.
  const roots = worktrees.map(w => normPath(w.path))
  const insideRepo = (cwd: string | null | undefined) => {
    if (!cwd) return true
    const p = normPath(cwd)
    return roots.some(r => p === r || p.startsWith(`${r}\\`))
  }

  const sessions: Session[] = []
  for (const e of entries) {
    const rec = cache.get(e.file)?.rec ?? byPath.get(normPath(e.file)) ?? { path: e.file }
    if (isEmpty(rec) || !insideRepo(rec.cwd)) continue
    sessions.push({
      id: e.id,
      file: e.file,
      mtimeMs: e.mtimeMs,
      dir: e.dir,
      name: rec.customTitle || null,
      aiTitle: rec.aiTitle || null,
      firstPrompt: rec.firstPrompt || rec.lastPrompt || null,
      branch: rec.gitBranch || null,
      cwd: rec.cwd || null,
      worktreeMissing: e.dir.path ? missing.get(e.dir.path) === true : false,
      error: rec.error || null,
    })
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const repoName = (worktrees[0]?.path ?? cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? projectDirName(cwd)
  return { repoName, worktrees, sessions }
}


/**
 * Switches this terminal to `target`: runs /resume for it; where the engine refuses that from a
 * plugin, puts `/resume <handle>` in the prompt box for the person to send.
 */
async function switchTo($: EngineInterface, id: string, handle: string): Promise<void> {
  try {
    await $.command.run({ command: 'resume', args: id })
  } catch (err) {
    const filled = await $.prompt.fill({ text: `/resume ${handle}` }).catch(() => ({ isFilled: false }))
    $.ui.toast(
      filled.isFilled
        ? '자동 전환이 안 돼서 입력창에 /resume 명령을 넣었습니다. Enter를 누르면 전환됩니다.'
        : `자동 전환 실패: /resume ${handle} 을 직접 입력하세요 (${String(err)})`,
    )
  }
}

async function loadPane($: EngineInterface, keyword: string | null, notice: string | null = null): Promise<PaneData> {
  const found = await findSessions($)
  const currentId = await $.session.id().catch(() => null)
  const nowMs = await $.clock.now()
  const shown = keyword ? found.sessions.filter(s => matchesKeyword(s, keyword)) : found.sessions
  const data: PaneData = {
    repoName: found.repoName,
    keyword,
    rows: shown.slice(0, 50).map(s => toRow(s, found.sessions, currentId, nowMs)),
    confirmId: null,
    notice,
  }
  await update($, pane, () => data)
  return data
}

async function pressRow($: EngineInterface, row: PaneRow): Promise<void> {
  const data = await read($, pane)
  if (row.isCurrent) {
    $.ui.toast('이미 현재 세션입니다.')
    return
  }
  if (row.isActive && data?.confirmId !== row.id) {
    await update($, pane, d => (d ? { ...d, confirmId: row.id } : d))
    return
  }
  await $.ui.close({ id: PANE }).catch(() => undefined)
  await update($, pane, () => null)
  await switchTo($, row.id, row.handle)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description: '이 저장소(메인 + worktree)의 세션을 패널로 보고 골라서 전환',
      argumentHint: '[키워드 | 번호 | --text]',
    })
    return started
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    try {
      return await runSessions($, (e.args ?? '').trim())
    } catch (err) {
      return { text: `/sessions 실패: ${String(err)}` }
    }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, pane, () => null).catch(() => undefined)
    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const data = await read($, pane)
    if (!data) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const cols = Math.max(30, e.props.bodyColumns)
    const firstPick = data.rows.find(r => !r.isCurrent)
    const confirming = data.rows.find(r => r.id === data.confirmId)

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>
            {fitWidth(`${data.repoName} 세션 ${data.rows.length}개${data.keyword ? ` · "${data.keyword}"` : ''}  `, cols - 22)}
          </Text>
          <Button key="refresh" label="새로고침" hotkey="r" plain onPress={() => loadPane($, data.keyword)} />
          <Text> </Text>
          <Button key="close" label="닫기" hotkey="q" plain role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
        <Text dimColor>{fitWidth('Tab/숫자키/클릭으로 선택 · Enter 전환 · Esc 닫기   ▶ 현재  ⚠ 2분 내 수정', cols)}</Text>
        {data.notice && <Text color="yellow">{fitWidth(data.notice, cols)}</Text>}
        {data.rows.length === 0 && <Text dimColor>{data.keyword ? '일치하는 세션이 없습니다.' : '표시할 세션이 없습니다.'}</Text>}
        {data.rows.map(row => {
          const mark = row.isCurrent ? '▶' : row.isActive ? '⚠' : ' '
          const head = `${mark} ${row.num}. `
          const meta = `  ${row.where} · ${row.when}`
          const room = cols - 4 - displayWidth(head)
          const title = fitWidth(row.title, Math.max(12, Math.min(displayWidth(row.title), room - Math.min(displayWidth(meta), room / 2))))
          const rest = fitWidth(meta, Math.max(0, room - displayWidth(title)))
          return (
            <Button
              key={row.id}
              plain
              dimColor={row.isCurrent}
              autoFocus={row === firstPick ? true : undefined}
              hotkey={row.num <= 9 ? String(row.num) : undefined}
              onPress={() => pressRow($, row)}
            >
              {head}
              {title}
              <Text dimColor>{rest}</Text>
            </Button>
          )
        })}
        {confirming && (
          <Text color="yellow">
            {fitWidth(`⚠ "${confirming.title}"는 2분 안에 수정됐습니다. 다른 터미널에서 열려 있으면 기록이 섞입니다. 한 번 더 누르면 전환합니다.`, cols * 2)}
          </Text>
        )}
      </Box>
    )
  })
}

async function runSessions($: EngineInterface, args: string): Promise<{ text: string }> {
  const isText = /(^|\s)--text(\s|$)/.test(args)
  const rest = args.replace(/(^|\s)--text(\s|$)/, ' ').trim()

  const pick = /^(\d+)\s*(!)?$/.exec(rest)
  if (pick) {
    const found = await findSessions($)
    const currentId = await $.session.id().catch(() => null)
    const nowMs = await $.clock.now()
    const target = found.sessions[Number(pick[1]) - 1]
    if (!target) return { text: `${pick[1]}번 세션이 없습니다. /sessions 로 목록을 확인하세요.` }
    if (target.id === currentId) return { text: `이미 현재 세션입니다: ${displayTitle(target)}` }
    const handle = resumeArg(target, found.sessions)
    if (nowMs - target.mtimeMs < ACTIVE_MS && !pick[2]) {
      return {
        text: [
          `⚠ "${displayTitle(target)}" 세션이 최근 2분 안에 수정됐습니다. 다른 터미널에서 사용 중일 수 있습니다.`,
          '같은 세션을 두 곳에서 열면 기록이 섞입니다. 다른 곳에서 열려 있지 않은 게 확실하면:',
          `  /sessions ${pick[1]} !`,
        ].join('\n'),
      }
    }
    // Run /resume once this command has finished, outside the hook the command waits on.
    $.clock.after(50, () => void switchTo($, target.id, handle))
    return { text: `→ "${displayTitle(target)}" 세션으로 전환합니다 (/resume ${handle})` }
  }

  if (!isText) {
    const data = await loadPane($, rest || null)
    const opened = await $.ui.open({ id: PANE, title: '세션', focus: true, closeOnEscape: true })
    if (opened.isPlaced) {
      return { text: `세션 패널을 열었습니다 (${data.rows.length}개). 숫자키·Tab·클릭으로 고르고 Esc로 닫습니다.` }
    }
    await $.ui.close({ id: PANE }).catch(() => undefined)
    // No room for a pane here: fall through to the text listing.
  }

  const found = await findSessions($)
  const currentId = await $.session.id().catch(() => null)
  const nowMs = await $.clock.now()
  const shown = rest ? found.sessions.filter(s => matchesKeyword(s, rest)) : found.sessions
  const text = formatListing({
    repoName: found.repoName,
    sessions: shown,
    all: found.sessions,
    currentId,
    nowMs,
    keyword: rest || undefined,
    limit: rest ? 50 : LIMIT,
    worktreeCount: found.worktrees.length,
  })
  return { text }
}
