import type { On } from 'claude-code'
import { describe, expect, test, type Engine } from 'claude-code/testing'

import {
  displayTitle,
  formatListing,
  isEmpty,
  matchesProjectDir,
  parseWorktrees,
  projectDirName,
  resumeArg,
  selectProjectDirs,
  type Session,
} from './lib'

const MAIN = 'C:\\Project\\Sample_App'
const WT = `${MAIN}\\.claude\\worktrees\\feat-dev-coverage`
const NOW = Date.UTC(2026, 9, 19, 5, 0, 0)

function session(over: Partial<Session> & { id: string }): Session {
  return {
    file: `${over.id}.jsonl`,
    mtimeMs: NOW - 3600_000,
    dir: { name: 'C--Project-Sample-App', label: 'main', origin: 'git', path: MAIN },
    name: null,
    aiTitle: null,
    firstPrompt: null,
    branch: 'master',
    cwd: MAIN,
    worktreeMissing: false,
    error: null,
    ...over,
  }
}

describe('path conversion', () => {
  test('replaces every non-alphanumeric, underscores and Korean included', () => {
    expect(projectDirName(MAIN)).toBe('C--Project-Sample-App')
    expect(projectDirName(WT)).toBe('C--Project-Sample-App--claude-worktrees-feat-dev-coverage')
    expect(projectDirName('C:\\Project\\html 정리')).toBe('C--Project-html---')
    expect(projectDirName('C:/Project/x')).toBe('C--Project-x')
  })

  test('matches a truncated + hashed name past 200 characters', () => {
    const long = `C:\\${'a'.repeat(250)}`
    const stored = `${projectDirName(long).slice(0, 200)}-1a2b3c`
    expect(matchesProjectDir(stored, long)).toBe(true)
    expect(matchesProjectDir('c--project-sample-app', MAIN)).toBe(true)
  })
})

describe('worktrees', () => {
  test('parses porcelain output, main first', () => {
    const out = `worktree C:/Project/Sample_App\nHEAD 4c71\nbranch refs/heads/master\n\nworktree C:/wt/x\nHEAD 1\ndetached\n`
    expect(parseWorktrees(out)).toEqual([
      { path: MAIN, branch: 'master' },
      { path: 'C:\\wt\\x', branch: null },
    ])
  })

  test('keeps listed worktrees and orphaned .claude/worktrees folders, nothing else', () => {
    const dirs = [
      'C--Project-Sample-App',
      'C--Project-Sample-App--claude-worktrees-feat-dev-coverage',
      'C--Project-QA-Ontology',
      'C--Project-Sample-App-2',
    ]
    const picked = selectProjectDirs(dirs, [{ path: MAIN, branch: 'master' }])
    expect(picked.map(d => [d.label, d.origin])).toEqual([
      ['main', 'git'],
      ['feat-dev-coverage', 'orphan'],
    ])
    expect(picked[1]?.path).toBe(WT)
  })
})

describe('sessions', () => {
  test('an empty session has no prompt and no reply', () => {
    expect(isEmpty({ path: 'a', hasPrompt: false, hasAssistant: false })).toBe(true)
    expect(isEmpty({ path: 'a', hasPrompt: true })).toBe(false)
    expect(isEmpty({ path: 'a', error: 'boom' })).toBe(false)
  })

  test('title: name, then ~generated title, then first prompt, then unknown', () => {
    expect(displayTitle(session({ id: 'a', name: '로컬 작업 세션', aiTitle: 'x' }))).toBe('로컬 작업 세션')
    expect(displayTitle(session({ id: 'a', aiTitle: 'Pro 테스트 실패' }))).toBe('~Pro 테스트 실패')
    expect(displayTitle(session({ id: 'a', firstPrompt: 'pro 안정화\n부탁해' }))).toBe('"pro 안정화 부탁해"')
    expect(displayTitle(session({ id: 'a' }))).toBe('(알 수 없음)')
  })

  test('resume by name unless another session shares it', () => {
    const a = session({ id: 'aaaa-1', name: '캔버스' })
    const b = session({ id: 'bbbb-2', name: '캔버스 ' })
    const c = session({ id: 'cccc-3', name: '단독' })
    const d = session({ id: 'dddd-4' })
    const all = [a, b, c, d]
    expect(resumeArg(a, all)).toBe('aaaa-1')
    expect(resumeArg(c, all)).toBe('단독')
    expect(resumeArg(d, all)).toBe('dddd-4')
  })

  test('listing marks current, recently written and deleted-worktree sessions', () => {
    const current = session({ id: 'cur00000-x', name: '현재', mtimeMs: NOW - 5_000 })
    const active = session({
      id: 'act00000-x',
      name: '개발캔버스',
      mtimeMs: NOW - 60_000,
      dir: { name: 'n', label: 'feat-dev-coverage', origin: 'orphan', path: WT },
      worktreeMissing: true,
    })
    const old = session({ id: 'old00000-x', firstPrompt: '첫 프롬프트' })
    const text = formatListing({
      repoName: 'Sample_App',
      sessions: [current, active, old],
      currentId: current.id,
      nowMs: NOW,
      worktreeCount: 1,
    })
    expect(text).toContain(' 1 ▶ 현재')
    expect(text).toContain('(현재 세션)')
    expect(text).toContain(' 2 ⚠ 개발캔버스')
    expect(text).toContain('feat-dev-coverage (삭제됨)')
    expect(text).toContain('/resume 개발캔버스   ⚠ 다른 터미널에서 사용 중일 수 있음')
    expect(text).toContain('/resume old00000-x')
    expect(text).toContain('1분 전')
  })
})

/** Answers git, the file listing and the scanner as Sample_App with one orphaned worktree. */
function fakeRepo($: Engine, on: On) {
  const root = 'C:\\Users\\me\\.claude\\projects'
  const files: Record<string, { name: string; mtimeMs: number }[]> = {
    'C--Project-Sample-App': [
      { name: 'b24bf69b-0000.jsonl', mtimeMs: NOW - 10_000 },
      { name: 'c34376e9-0000.jsonl', mtimeMs: NOW - 50_000_000 },
      { name: '45a42876-0000.jsonl', mtimeMs: NOW - 99_000_000 },
    ],
    'C--Project-Sample-App--claude-worktrees-feat-dev-coverage': [
      { name: 'b3efafc1-0000.jsonl', mtimeMs: NOW - 30_000 },
    ],
  }
  const seen = { scanInput: '' }
  const ran = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }))
  on('session.cwd', () => ({ value: MAIN }))
  on('session.id', () => ({ value: 'b24bf69b-0000' }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', ($, e) => {
    const entry = (name: string, kind: 'file' | 'dir', mtimeMs = 0) => ({ name, kind, size: 100, mtimeMs, isLink: false })
    if (e.path === root) return { value: [...Object.keys(files), 'C--Project-Other'].map(n => entry(n, 'dir')) }
    const dir = e.path.slice(root.length + 1)
    return { value: (files[dir] ?? []).map(f => entry(f.name, 'file', f.mtimeMs)) }
  })
  on('process.run', ($, e) => {
    if (e.argv[0] === 'git') {
      return { value: ran('worktree C:/Project/Sample_App\nHEAD 1\nbranch refs/heads/master\n') }
    }
    seen.scanInput = e.init?.stdin ?? ''
    const paths: string[] = JSON.parse(seen.scanInput).files
    const recs = paths.map(path =>
      path.includes('b24bf69b')
        ? { path, customTitle: '로컬 작업 세션', gitBranch: 'master', cwd: MAIN, hasPrompt: true, hasAssistant: true }
        : path.includes('b3efafc1')
          ? { path, customTitle: '로컬 개발캔버스', gitBranch: 'feat/ops-phase1', cwd: WT, hasPrompt: true, hasAssistant: true }
          : path.includes('c34376e9')
            ? { path, aiTitle: 'dev-coverage 세션', gitBranch: 'fix/pro-stabilize', cwd: MAIN, hasPrompt: true, hasAssistant: true }
            : { path, hasPrompt: false, hasAssistant: false },
    )
    return { value: ran(JSON.stringify(recs)) }
  })

  const sessions = (args = '') =>
    $.command.run({
      command: 'sessions',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 160 },
    })
  return { seen, sessions }
}

test('/sessions --text lists main and worktree sessions through git, the file listing and the scanner', async ($, on) => {
  const { seen, sessions } = fakeRepo($, on)

  const { text } = await sessions('--text')
  expect(seen.scanInput).not.toMatch(/[^\x00-\x7f]/)
  expect(text).toContain('Sample_App 세션 3개')
  expect(text).toContain(' 1 ▶ 로컬 작업 세션')
  expect(text).toContain(' 2 ⚠ 로컬 개발캔버스')
  expect(text).toContain('feat-dev-coverage (git 미등록) · feat/ops-phase1')
  expect(text).toContain('/resume 로컬 개발캔버스')
  expect(text).not.toContain('45a42876')

  const filtered = await sessions('개발 --text')
  expect(filtered.text).toContain('검색 결과 1개')
  expect(filtered.text).toContain(' 2 ⚠ 로컬 개발캔버스')

  const guarded = await sessions('2')
  expect(guarded.text).toContain('/sessions 2 !')
  const self = await sessions('1')
  expect(self.text).toContain('이미 현재 세션')
})

test('/sessions opens a pane whose rows switch with /resume, an active one after a second press', async ($, on) => {
  const { sessions } = fakeRepo($, on)
  let resumed: string | undefined
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('command.run', { command: 'resume' }, ($, e) => {
    resumed = e.args
    return { text: '' }
  })

  const opened = await sessions()
  expect(opened.text).toContain('세션 패널을 열었습니다 (3개)')

  for (const surface of ['terminal', 'desktop'] as const) {
    resumed = undefined
    await sessions()
    const ui = await $.ui.mount({
      plugin: 'repo-sessions',
      surface,
      component: 'Pane',
      requestId: 'repo-sessions',
      props: {
        title: '세션',
        isFocused: true,
        bodyColumns: 100,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    })
    expect(await ui.findAll({ type: 'Button', text: /로컬|dev-coverage/ })).toHaveLength(3)

    await ui.press({ key: 'b3efafc1-0000' })
    expect(resumed).toBeUndefined()
    expect(await ui.find({ text: /한 번 더 누르면 전환/ })).toBeDefined()

    await ui.press({ key: 'b3efafc1-0000' })
    expect(resumed).toBe('b3efafc1-0000')
    await ui.unmount()
  }
})
