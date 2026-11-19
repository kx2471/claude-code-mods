// Pure helpers for /sessions: path conversion, worktree parsing, labels and the listing text.
// Nothing here touches the engine, so the tests exercise it directly.

export const UNKNOWN = '(알 수 없음)'
export const ACTIVE_MS = 2 * 60 * 1000
const MAX_DIR_NAME = 200

/** One transcript's metadata as scan-sessions.ps1 reports it (every field best effort). */
export type ScanRecord = {
  path: string
  customTitle?: string | null
  aiTitle?: string | null
  firstPrompt?: string | null
  lastPrompt?: string | null
  gitBranch?: string | null
  cwd?: string | null
  hasPrompt?: boolean
  hasAssistant?: boolean
  error?: string | null
}

export type Worktree = { path: string; branch: string | null }

/** Where a project directory under ~/.claude/projects came from. */
export type ProjectDir = {
  name: string
  /** The worktree it belongs to, or the folder name of a worktree git no longer lists. */
  label: string
  /** 'git': listed by `git worktree list`; 'orphan': a .claude/worktrees folder git no longer lists. */
  origin: 'git' | 'orphan'
  /** Absolute worktree path, when known. */
  path: string | null
}

export type Session = {
  id: string
  file: string
  mtimeMs: number
  dir: ProjectDir
  name: string | null
  aiTitle: string | null
  firstPrompt: string | null
  branch: string | null
  cwd: string | null
  worktreeMissing: boolean
  error: string | null
}

/** Claude Code's project-directory name for a working directory: non-alphanumerics become '-'. */
export function projectDirName(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Whether `dirName` is the project directory of `path`, allowing for the 200-char truncation + hash. */
export function matchesProjectDir(dirName: string, path: string): boolean {
  const full = projectDirName(path)
  if (full.length <= MAX_DIR_NAME) return dirName.toLowerCase() === full.toLowerCase()
  return dirName.toLowerCase().startsWith(full.slice(0, MAX_DIR_NAME).toLowerCase())
}

export function normPath(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** Parses `git worktree list --porcelain`; the main worktree comes first. */
export function parseWorktrees(porcelain: string): Worktree[] {
  const out: Worktree[] = []
  for (const block of porcelain.replace(/\r/g, '').split(/\n\n+/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    if (!path) continue
    const ref = /^branch (.+)$/m.exec(block)?.[1]
    out.push({ path: path.replace(/\//g, '\\'), branch: ref ? ref.replace(/^refs\/heads\//, '') : null })
  }
  return out
}

/**
 * Picks the project directories that hold this repository's sessions: each listed worktree's own,
 * plus `<main>--claude-worktrees-<name>` folders whose worktree git no longer lists.
 */
export function selectProjectDirs(dirNames: readonly string[], worktrees: readonly Worktree[]): ProjectDir[] {
  const main = worktrees[0]
  if (!main) return []
  const orphanPrefix = `${projectDirName(main.path)}--claude-worktrees-`.toLowerCase()
  const picked: ProjectDir[] = []
  for (const name of dirNames) {
    const wt = worktrees.find(w => matchesProjectDir(name, w.path))
    if (wt) {
      const label = wt === main ? 'main' : baseName(wt.path)
      picked.push({ name, label, origin: 'git', path: wt.path })
    } else if (name.toLowerCase().startsWith(orphanPrefix)) {
      const label = name.slice(orphanPrefix.length)
      picked.push({ name, label, origin: 'orphan', path: `${main.path}\\.claude\\worktrees\\${label}` })
    }
  }
  return picked
}

function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
}

/** A session with neither a typed prompt nor a reply holds no conversation to resume. */
export function isEmpty(r: ScanRecord): boolean {
  return !r.error && !r.hasPrompt && !r.hasAssistant
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** What the list shows as the title: the /rename name, else ~generated title, else the first prompt. */
export function displayTitle(s: Session, max = 48): string {
  if (s.name) return oneLine(s.name, max)
  if (s.aiTitle) return `~${oneLine(s.aiTitle, max - 1)}`
  if (s.firstPrompt) return `"${oneLine(s.firstPrompt, max - 2)}"`
  return UNKNOWN
}

/**
 * The argument `/resume` takes for a session: its name when no other session of the repository
 * shares it (`/resume <name>` errors on an ambiguous name), else its full id.
 */
export function resumeArg(s: Session, all: readonly Session[]): string {
  if (!s.name) return s.id
  const key = s.name.trim().toLowerCase()
  const clash = all.some(o => o !== s && (o.name ?? '').trim().toLowerCase() === key)
  return clash ? s.id : s.name.trim()
}

export function matchesKeyword(s: Session, keyword: string): boolean {
  const k = keyword.toLowerCase()
  return [s.name, s.aiTitle, s.firstPrompt, s.branch, s.dir.label, s.id]
    .some(v => (v ?? '').toLowerCase().includes(k))
}

const pad = (n: number) => String(n).padStart(2, '0')

export function relativeTime(mtimeMs: number, nowMs: number): string {
  const sec = Math.max(0, Math.round((nowMs - mtimeMs) / 1000))
  if (sec < 60) return '방금'
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`
  const d = new Date(mtimeMs)
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function worktreeLabel(s: Session): string {
  if (s.dir.origin === 'orphan') return `${s.dir.label} (${s.worktreeMissing ? '삭제됨' : 'git 미등록'})`
  if (s.worktreeMissing) return `${s.dir.label} (삭제됨)`
  return s.dir.label
}

export type ListingInput = {
  repoName: string
  sessions: readonly Session[]
  /** All sessions of the repository, for name-clash checks; defaults to `sessions`. */
  all?: readonly Session[]
  currentId: string | null
  nowMs: number
  keyword?: string
  limit?: number
  worktreeCount: number
}

/** The text /sessions prints: two lines per session, newest first, numbered for `/sessions <n>`. */
export function formatListing(input: ListingInput): string {
  const { sessions, currentId, nowMs, keyword } = input
  const all = input.all ?? sessions
  const limit = input.limit ?? 20
  const lines: string[] = []
  const scope = `메인 + worktree ${Math.max(0, input.worktreeCount - 1)}`
  const head = keyword
    ? `${input.repoName} 세션 중 "${keyword}" 검색 결과 ${sessions.length}개 (${scope})`
    : `${input.repoName} 세션 ${sessions.length}개 (${scope}), 최근 수정순`
  lines.push(head)
  if (sessions.length === 0) {
    lines.push(keyword ? '  일치하는 세션이 없습니다.' : '  표시할 세션이 없습니다.')
    return lines.join('\n')
  }

  sessions.slice(0, limit).forEach((s, i) => {
    const isCurrent = s.id === currentId
    const isActive = !isCurrent && nowMs - s.mtimeMs < ACTIVE_MS
    const mark = isCurrent ? '▶' : isActive ? '⚠' : ' '
    // Numbered by position in the full list, so `/sessions <n>` means the same session after a search.
    const at = all.indexOf(s)
    const num = String((at >= 0 ? at : i) + 1).padStart(2, ' ')
    lines.push(`${num} ${mark} ${displayTitle(s)}`)
    const where = `${worktreeLabel(s)} · ${s.branch ?? UNKNOWN}`
    const when = `${relativeTime(s.mtimeMs, nowMs)} · ${s.id.slice(0, 8)}`
    const action = isCurrent
      ? '(현재 세션)'
      : `/resume ${resumeArg(s, all)}${isActive ? '   ⚠ 다른 터미널에서 사용 중일 수 있음' : ''}`
    lines.push(`      ${where} · ${when}`)
    lines.push(`      ${action}`)
    if (s.error) lines.push(`      (읽기 오류: ${oneLine(s.error, 80)})`)
  })

  if (sessions.length > limit) {
    lines.push(`  … 외 ${sessions.length - limit}개. /sessions <키워드> 로 찾을 수 있습니다.`)
  }
  lines.push('')
  lines.push('▶ 현재 세션   ⚠ 2분 내 수정됨: 같은 세션을 두 곳에서 열면 기록이 섞입니다   ~ 자동 생성 제목')
  lines.push('전환: 위 /resume 명령을 입력하거나 /sessions <번호>')
  const unnamed = sessions.filter(s => !s.name).length
  if (unnamed >= 3 && unnamed * 2 >= sessions.length) {
    lines.push(`이름 없는 세션이 ${unnamed}개입니다. 해당 세션에서 /rename <이름> 으로 이름을 붙이면 찾고 전환하기 쉽습니다.`)
  }
  return lines.join('\n')
}

/** Terminal cells a string takes: Hangul, CJK and full-width forms take two. */
export function displayWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff)
    w += wide ? 2 : 1
  }
  return w
}

/** Cuts `text` to at most `cells` terminal cells, ending in … when cut. */
export function fitWidth(text: string, cells: number): string {
  if (cells <= 0) return ''
  if (displayWidth(text) <= cells) return text
  let out = ''
  for (const ch of text) {
    if (displayWidth(out + ch) > cells - 1) break
    out += ch
  }
  return `${out}…`
}

/** A session as one pane row, numbered by its place in the full list. */
export function toRow(s: Session, all: readonly Session[], currentId: string | null, nowMs: number) {
  const isCurrent = s.id === currentId
  return {
    id: s.id,
    num: all.indexOf(s) + 1,
    title: displayTitle(s, 80),
    where: `${worktreeLabel(s)} · ${s.branch ?? UNKNOWN}`,
    when: `${relativeTime(s.mtimeMs, nowMs)} · ${s.id.slice(0, 8)}`,
    handle: resumeArg(s, all),
    isCurrent,
    isActive: !isCurrent && nowMs - s.mtimeMs < ACTIVE_MS,
  }
}

/** Escapes everything outside ASCII so the scanner's stdin survives any console code page. */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0080-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
