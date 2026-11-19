# Claude Code mods 요구사항

작성자: sangok.kim
최종 수정: 2026-10-15

이 폴더(`C:\Project\claude_mode`)는 개인용 Claude Code mod를 모아 두는 로컬 마켓플레이스 `my-mods`입니다.

---

## 공통 요구사항

| ID | 요구사항 |
|---|---|
| C-1 | 모든 mod는 이 폴더 아래 각자의 하위 폴더에 둔다. |
| C-2 | 모든 mod는 `.claude-plugin/marketplace.json`에 등록하고 user 범위로 설치해, 어느 Claude Code 세션에서든 자동으로 켜지게 한다. |
| C-3 | 코드를 수정하면 `/reload-plugins`만으로 반영되어야 한다 (재설치 불필요). |
| C-4 | 모든 mod는 `claude plugin validate`를 통과해야 한다. |
| C-5 | 모든 mod는 `*.test.ts` 자동 테스트를 하나 이상 가지고, `claude plugin test`를 통과해야 한다. |
| C-6 | mod에서 오류가 나도 Claude Code의 원래 동작(도구 실행 등)을 막으면 안 된다. |

---

## 1. usage-band — 사용량·컨텍스트 표시

**목적:** 현재 사용량과 컨텍스트 상태를 따로 명령어를 입력하지 않고 항상 볼 수 있게 한다.

### 표시 위치
| ID | 요구사항 |
|---|---|
| U-1 | 입력창(프롬프트) 바로 위에 표시한다. 1줄: 사용량, 2줄: 할 일 (있을 때만). |
| U-2 | 설문(survey)이 표시되는 동안에는 자리를 양보하고 숨긴다. |

### 표시 항목
| ID | 항목 | 형식 | 비고 |
|---|---|---|---|
| U-3 | 컨텍스트 사용률 | `컨텍스트 ████░░░░░░ 42% (84k/200k)` | 막대 10칸. 사용 토큰 / 전체 창 크기. 첫 응답 전에는 `-` |
| U-4 | 5시간 사용 한도 | `5시간 ██░░░░░░░░ 23% (2h10m)` | 막대 10칸, 괄호는 리셋까지 남은 시간. 구독 요금제에서만 표시 |
| U-5 | 주간 사용 한도 | `주간 █░░░░░░░░░ 10% (2d2h)` | 하루 이상 남으면 일 단위. 구독 요금제에서만 표시 |
| U-6 | 지출 한도 | `지출 ███░░░░░░░ N%` | 게이트웨이 사용 시에만 표시 |
| U-7 | 세션 비용 | `$1.23` | `/cost`와 같은 값. API 요금 환산액이며 구독 요금제에서는 참고용 |

항목 사이는 ` · `로 구분한다.

### 할 일 (Claude 작업 체크리스트)
| ID | 요구사항 |
|---|---|
| U-13 | Claude가 작업 체크리스트(TodoWrite, TaskCreate/TaskUpdate, 또는 mod 자체 도구 `checklist`)를 만들거나 고치면 두 번째 줄에 표시한다. |
| U-18 | 기본 체크리스트 도구가 없는 세션에서도 쓸 수 있도록 mod가 `mcp__usage-band__checklist` 도구를 Claude에게 직접 제공한다 (전체 목록을 매번 보내는 방식, 빈 목록이면 지움). |
| U-14 | 형식: `할 일 ████░░░░░░ 2/5 · 진행 중: 테스트 작성 중` — 막대는 완료 비율, 초록색. |
| U-15 | 진행 중 항목이 있으면 `진행 중: <activeForm>`, 없으면 다음 대기 항목을 `다음: <내용>`으로 표시한다. |
| U-16 | 목록이 없거나 모든 항목이 완료되면 두 번째 줄을 숨긴다. |
| U-17 | 목록은 세션 상태(`$.state`)에 저장해 `/reload-plugins` 후에도 유지한다. 체크리스트 추적 중 오류가 나도 도구 실행은 막지 않는다. |

### 색상
| ID | 조건 | 색 |
|---|---|---|
| U-8 | 70% 미만 | 흐린 색 (subtle) |
| U-9 | 70% 이상 | 노란색 (warning) |
| U-10 | 90% 이상 | 빨간색 (error) |

컨텍스트와 각 사용 한도의 막대(채워진 칸)와 퍼센트에 각각 적용한다. 빈 칸은 항상 흐린 색.

### 갱신
| ID | 요구사항 |
|---|---|
| U-11 | Claude의 답변이 끝날 때마다, 그리고 사용 한도가 1% 이상 바뀔 때마다 자동으로 갱신한다. |
| U-12 | 값을 읽는 데 추가 API 호출(토큰 소모)이 없어야 한다. |

### 구현 메모
- 코드: `usage-band/hooks/register.tsx`
- 데이터: `$.session.usage()` (상태줄과 같은 값)
- 갱신 신호: `session.measure` 이벤트 → `$.ui.invalidate('ui.render')`
- 그리기: `ui.render` 훅, `component: 'AbovePrompt'`
- 할 일: `session.start`에서 `$.tool.register`로 `checklist` 도구 등록, `tool.call` 훅으로 checklist / TodoWrite / TaskCreate / TaskUpdate를 처리해 `$.state`(`usage-band.todos`)에 보관. 타입 계약: `types/index.d.ts`
- 테스트: `hooks/register.test.ts`, `hooks/todos.test.ts`

### 미정 / 개선 후보
- [x] 리셋까지 남은 시간이 하루를 넘으면 `2d3h`처럼 일 단위로 표시 (v0.2.0)
- [x] 막대 그래프로 표시 (v0.2.0)
- [ ] 터미널 맨 위에 고정 표시 — mod API에 해당 위치가 없어 보류
- [x] Claude 작업 체크리스트 표시 (v0.3.0)
- [x] 체크리스트를 `/reload-plugins` 후에도 유지 (v0.4.0)
- [x] mod 자체 체크리스트 도구 제공 (v0.4.0)
- [ ] 표시 항목을 켜고 끌 수 있는 설정
- [ ] 컨텍스트가 일정 % 를 넘으면 토스트 알림

---

## 2. tool-counter — 도구 호출 카운터 (연습용)

**목적:** mod 동작 방식을 익히기 위한 예제. 공식 문서 예제를 TypeScript로 옮긴 것.

| ID | 요구사항 |
|---|---|
| T-1 | Claude가 도구를 호출할 때마다 횟수를 1씩 센다. |
| T-2 | 작업 중 스피너 뒤에 ` · tool calls: N…`을 붙여 표시한다. |
| T-3 | 카운트는 세션 시작·`/reload-plugins` 시 0으로 초기화된다. |
| T-4 | 카운트 중 오류가 나도 도구 실행은 그대로 진행한다. |

- 코드: `tool-counter/hooks/register.ts`
- 상태: 연습용이므로 필요 없으면 제거 가능 (`claude plugin uninstall tool-counter@my-mods`)
