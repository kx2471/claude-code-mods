# todo-panel

Claude가 이번 세션에서 해야 할 일과 내가 직접 적은 할 일을 한 패널에서 보여주는 Claude Code mod입니다. Claude가 작업을 끝내면 체크박스가 자동으로 체크됩니다.

## 설치

이 mod는 `C:\Project\claude_mode`의 폴더 마켓플레이스 `my-mods`에 등록되어 있습니다. user 범위로 설치하면 이후 모든 세션에서 자동으로 로드됩니다.

```
claude plugin marketplace add C:\Project\claude_mode   # my-mods가 아직 없을 때만
claude plugin install todo-panel@my-mods --scope user
```

폴더 마켓플레이스에서 상대 경로(`./todo-panel`)로 설치했기 때문에 Claude Code는 복사본이 아니라 이 폴더를 직접 읽습니다. 파일을 고친 뒤 실행 중인 세션에서 `/reload-plugins`를 실행하면 반영됩니다.

개발 중에 한 세션에서만 쓰려면 `claude --plugin-dir C:\Project\claude_mode\todo-panel`로 실행하면 됩니다.

## 사용법

- 세션이 시작되면 패널이 자동으로 열립니다. 패널의 `시작 시 열기` 버튼으로 끌 수 있고, 이 설정은 다음 세션에도 유지됩니다. 터미널이 충분히 넓지 않으면(엔진 기준 144열) 열릴 자리가 생길 때까지 대기합니다.
- `/todo-panel`: 패널을 엽니다. Esc로 닫습니다.
- 상단: 진행률 바와 `완료 N / 전체 M`, 현재 모델. 맨 아래 `설정` 줄에 요약 띠·시작 시 열기·AI 설명·AI 계획 켜기/끄기가 모여 있고, 좁으면 줄바꿈됩니다.
- 섹션: `▶ 진행 중` / `☐ 남은 일` / `☑ 완료`. 완료 섹션 머리글을 누르면 접히고 펼쳐집니다.
- 입력창에 할 일을 적고 Enter를 누르면 추가됩니다. `섹션명: 내용` 형식으로 적으면 그 섹션 아래로 묶입니다.
- 내가 추가한 항목은 클릭하면 체크가 토글되고, `삭제` 버튼으로 지울 수 있습니다.
- 출처 표시: `[Claude]`는 Claude가 할 일 도구로 만든 항목, `[요청]`은 내 요청, `[AI 계획]`은 Haiku가 나눈 단계(셋 다 읽기 전용), `[수동]`은 내가 추가한 항목입니다.
- 요청을 할 일로: Claude가 목록을 만들지 않은 턴은 첫 도구 호출 때 내 요청(첫 줄, 60자)을 `[요청]`으로 올리고, 턴이 끝나면 ☑, 중단되면 ☐(남은 일)로 둡니다. 도구를 쓰지 않은 턴은 올리지 않습니다. 지난 요청은 완료 섹션에 최근 10개까지 남습니다.
- AI 계획(Haiku): 그 턴의 도구 호출이 2번이 되도록 Claude가 목록을 만들지 않았으면 Haiku가 요청을 3~5단계로 나눠 `[AI 계획]`으로 올리고, 이후 호출 3번마다 탐색 과정을 보고 단계를 체크합니다. 턴이 정상적으로 끝나면 모델 호출 없이 모두 ☑로, 중단되면 한 번 더 확인합니다. 새 턴이 시작되면 지난 계획은 지웁니다. 패널의 `AI 계획(Haiku)` 버튼으로 끌 수 있습니다.
- Claude가 그 턴에 직접 목록(`checklist`/`TodoWrite`/`TaskCreate`)을 만들면 그게 실제 계획이므로 `[요청]`과 `[AI 계획]`은 치우고 더 묻지 않습니다. 완료 토스트도 Claude가 만든 목록에만 띄웁니다.
- 패널 상단에 현재 세션 모델과 effort(`모델: claude-opus-5-5 · effort: high`)를 표시합니다. 모델은 세션 시작, `/model` 전환(`classic.PostModelSwitch`), 매 턴 시작 때 갱신합니다. effort는 메인 대화의 모델 요청이 나갈 때(`turn.step`) 실제로 실린 값(`/effort`, 모델 지원 범위, 상한이 반영된 값)을 읽으므로, 세션의 첫 요청 전이나 effort를 받지 않는 모델에서는 표시되지 않습니다. 요약 띠에는 `claude-opus-5-5 (high)`로 붙습니다.
- 스킬 사용 표시: 스킬이 쓰이면(내가 `/이름`으로 부르든 Claude가 Skill 도구로 부르든) 패널 상단 모델 줄 아래에 `스킬 사용 중: plugin-authoring`이, 요약 띠에 `스킬: …`가 나옵니다. 엔진이 스킬 본문을 모델에 펼치는 `skill.prompt`를 관찰하며(본문은 바꾸지 않음), 그 턴이 끝나면 지웁니다. 최근 5개까지 보여줍니다.
- 프롬프트 위 요약 띠: `☑ 3/7 · 진행 중: ○○ · 스킬: ○○ · 모델`. 할 일도 사용 중인 스킬도 없거나 띠를 꺼 두면 표시되지 않습니다.
- Claude의 할 일이 모두 완료되면 토스트로 한 번 알려줍니다.
- `탐색 과정`: Claude가 이번 턴에 메인 대화에서 실제로 호출한 도구를 순서대로 보여줍니다(`· 검색 "pane"` → `✓`, 실패는 `✗`). Claude가 할 일 목록을 만들지 않는 질문 답변에서도 어떤 과정을 거쳤는지 볼 수 있습니다. 할 일 도구는 할 일 섹션에 나오므로 여기서는 빠지고, 서브에이전트 안의 호출은 `에이전트 …` 한 줄로만 보입니다. 새 턴이 시작되면 비워지고, 최근 15개를 보여주며 머리글을 눌러 접을 수 있습니다.
  - 이유는 두 가지 방식으로 붙습니다.
    - `»` (Claude): Claude가 도구를 부르기 직전에 쓴 응답 텍스트의 마지막 줄을 그대로 씁니다(마크다운 기호 제거, 90자). 같은 줄로 이어진 호출은 한 묶음으로 보입니다. 도구 결과가 들어오면 그 줄은 소진되어, 다음 메시지의 호출에 지난 문장이 붙지 않습니다.
    - `↳` (Haiku): Claude가 이유를 쓰지 않은 호출이면, 호출이 진행된 뒤 타이머로 Haiku(`$.model.complete`, 모델 `haiku`)에 한 줄 설명을 요청해 그 줄 아래에 붙입니다. 도구 실행은 이를 기다리지 않습니다. 패널의 `AI 설명(Haiku)` 버튼으로 끌 수 있습니다.

### Claude 작업 자동 추적

Claude Code 2.1.303의 타입 선언을 기준으로 두 방식을 모두 지원합니다.

| 도구 | 반영 방식 |
|---|---|
| `TodoWrite` | 결과의 `newTodos`(없으면 입력의 `todos`)로 Claude 목록 전체를 교체 |
| `TaskCreate` | 결과의 `task.id`로 항목 생성 |
| `TaskUpdate` | `status: completed`면 체크, `deleted`면 제거, 그 밖의 필드는 갱신 |
| usage-band `checklist` | usage-band가 목록을 자기 상태에 쓰는 `state.set`을 관찰해 `TodoWrite`처럼 전체 교체 (값은 바꾸지 않고 그대로 통과) |

거부(`deny`)됐거나 오류(`isError`)가 난 호출, `success: false`인 `TaskUpdate`는 반영하지 않습니다. 서브에이전트의 `TodoWrite`는 그 에이전트 자신의 목록이므로 반영하지 않습니다.

## 접근 범위

`claude plugin validate`가 보고한 내용입니다.

- hooks: `session.start`, `classic.SessionStart`, `classic.PostModelSwitch`, `turn.start`, `turn.complete`(요청·계획 마무리), `turn.step`(effort 읽기, 요청은 그대로 전송), `session.append{door=response}`(Claude 응답의 마지막 줄을 이유로 기억), `session.append{door=tool-result}`(이유 소진), `tool.call`(모든 도구, 탐색 과정 기록), `command.run{command=todo-panel}`, `tool.call{tool=TodoWrite}`, `state.set{plugin=usage-band, key=todos}`, `tool.call{tool=TaskCreate}`, `tool.call{tool=TaskUpdate}`, `skill.prompt`(사용 중인 스킬 이름), `ui.render{component=Pane, requestId=todo-panel}`, `ui.render{component=AbovePrompt}`
- calls: `$.clock.after`, `$.model.complete`, `$.command.register`, `$.session.cwd`, `$.session.model`, `$.state.get`, `$.state.set`, `$.store.get`, `$.store.set`, `$.ui.open`, `$.ui.resolve`, `$.ui.toast`

`tool.call`·`state.set` 훅은 관찰만 합니다. 탐색 과정 기록은 도구 이름과 인자(검색어, 파일 이름, 명령 설명)만 패널에 보여줄 뿐 저장하지 않습니다. 단, `AI 설명(Haiku)`이 켜져 있으면 Claude가 이유를 쓰지 않은 호출마다 이번 턴의 요청(300자), 직전 3단계 이름, 호출 이름과 세부(명령·경로·검색어 200자)를 세션과 같은 Claude API로 Haiku에 보냅니다(호출당 짧은 요청 하나의 비용). `AI 계획(Haiku)`이 켜져 있으면 목록 없는 턴마다 계획 요청 1번과 호출 3번마다 확인 요청 1번에 이번 턴의 요청과 탐색 과정(호출 이름과 이유)을 보냅니다. 이 외에 네트워크는 쓰지 않습니다. 호출을 `next(e)`에 그대로 넘기고 받은 결과를 바꾸지 않은 채 반환합니다. 집계 중에 오류가 나도 `.catch`가 같은 결과를 그대로 돌려줍니다. 파일 쓰기, 프로세스 실행, 시스템 프롬프트 변경은 하지 않습니다.

## 저장

- `$.state` (세션): `claude`(Claude 항목), `manual`(수동 항목), `prefs`(요약 띠·완료 섹션 펼침), `model`(세션 모델), `effort`(마지막 요청의 effort), `activity`(이번 턴의 도구 호출과 이유), `narration`(이번 턴에 Claude가 마지막으로 쓴 줄), `turnPrompt`(이번 턴의 요청), `turn`(이번 턴의 호출 수·Claude 목록 여부·계획 요청 여부), `skills`(이번 턴에 쓰인 스킬 이름), `restoredFor`(복원한 워크스페이스)
- `$.store` (세션 간): `manual:<워크스페이스 경로>`에 수동 항목, `prefs`에 표시 설정(요약 띠, 완료 섹션 펼침, 시작 시 열기, 탐색 과정 펼침, AI 설명, AI 계획). `classic.SessionStart`(startup/resume/clear/compact/fork)마다 현재 워크스페이스 값으로 복원합니다.

## 제약 사항

- 패널의 긴 문장은 자르지 않고 줄바꿈합니다. 각 줄은 표시 기호(▶ ☐ ☑ ✓ ✗ · » ↳)를 2칸 고정 열에 두고, 본문은 그 오른쪽에서 줄바꿈되어 기호 아래로 흘러내리지 않습니다. 터미널마다 폭이 달라지는 이모지는 쓰지 않습니다. 프롬프트 위 요약 띠만 한 줄 유지를 위해 끝을 자릅니다.
- 모든 표시 문자열은 제어문자·양방향 제어문자를 제거하고 200자(띠의 진행 중 항목은 60자)로 자릅니다. 수동 항목은 워크스페이스당 300개, Claude 항목은 200개까지 보관합니다.
- `/clear` 후에는 Claude 항목을 비웁니다. 수동 항목은 store에서 복원됩니다.
- 모바일 화면에는 입력창이 없어 패널이 읽기 전용으로 표시됩니다. 요약 띠는 엔진이 terminal과 desktop에서만 그립니다.
- 조직이 Claude Code를 관리하는 환경에서는 조직 플러그인이 `classic.SessionStart`를 먼저 처리하고 넘겨서 이 mod의 훅이 실행되지 않을 수 있습니다. 그래도 세션 시작 때(`session.start`), 그리고 `/clear` 뒤 첫 턴이 시작될 때(`turn.start`) 현재 워크스페이스의 수동 항목을 store에서 복원합니다.
- `TodoWrite` 항목에는 ID가 없어 목록 안의 순서로 식별합니다.

## 테스트

```
claude plugin validate ./todo-panel --strict
claude plugin test ./todo-panel
```

테스트(`tests/todo-panel.test.ts`, terminal·desktop 각각)는 명령 등록과 패널 열기, 다른 플러그인 패널을 건드리지 않음, TaskCreate/TaskUpdate/TodoWrite 반영과 자동 체크, deny/isError 무시, 수동 추가·토글·삭제·섹션 묶기·store 복원, 빈 상태, 요약 띠 on/off와 아래쪽 렌더 결과 유지를 확인합니다.
