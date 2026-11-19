# my-mods

개인용 Claude Code mod 모음입니다. 이 저장소 자체가 Claude Code 플러그인 마켓플레이스 `my-mods`입니다.

| mod | 설명 |
|---|---|
| [todo-panel](./todo-panel) | Claude의 할 일, 내 할 일, 탐색 과정, 사용 중인 스킬, 모델·effort를 보여주는 패널 |
| [usage-band](./usage-band) | 입력창 위에 사용량과 컨텍스트를 보여주는 띠, Claude용 `checklist` 도구 |
| [tool-counter](./tool-counter) | 도구 호출 횟수 집계 |
| [repo-sessions](./repo-sessions) | 저장소별 세션 목록 |

## 설치

Claude Code에서:

```
/plugin marketplace add kx2471/claude-code-mods
/plugin install todo-panel@my-mods
/plugin install usage-band@my-mods
```

터미널에서는 `claude plugin marketplace add kx2471/claude-code-mods`, `claude plugin install todo-panel@my-mods --scope user`처럼 실행합니다.

## 업데이트

```
/plugin marketplace update my-mods
/reload-plugins
```

## 개발

```
claude plugin validate ./todo-panel --strict
claude plugin test ./todo-panel
```
