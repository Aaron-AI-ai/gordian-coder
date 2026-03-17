# Gordian Coder — Cline Hooks 연동 가이드

## 1. 개요

gordian-coder는 Cline의 [Hooks](https://docs.cline.bot/features/hooks) 시스템과 연동하여, Cline 워크플로우의 주요 시점에 커스텀 로직을 실행할 수 있습니다.

### 동작 방식

Cline은 hook 이벤트가 발생할 때마다 **새 프로세스를 실행**(one-shot)하고, stdin으로 JSON을 보낸 뒤, stdout에서 JSON 응답을 읽습니다.

```
Cline                          gdc
  │                                    │
  │  spawn process                     │
  ├───────────────────────────────────>│
  │  stdin: {"hookName":"PreToolUse",..}│
  ├───────────────────────────────────>│
  │                                    │ 핸들러 실행
  │  stdout: {"cancel":false,...}      │
  │<───────────────────────────────────┤
  │  process exits                     │
  └────────────────────────────────────┘
```

---

## 2. 설치

```bash
# 의존성 설치
bun install

# 빌드
bun run build

# 글로벌 명령어 등록 (선택)
bun link
```

빌드 후 `gdc` 명령어를 사용할 수 있습니다.

---

## 3. 빠른 시작

### 자동 설정 (권장)

```bash
# 프로젝트 로컬 hooks 설정 (.clinerules/hooks/)
gdc --init

# 글로벌 hooks 설정 (~/Documents/Cline/Hooks/)
gdc --init --global

# 기존 hooks 덮어쓰기
gdc --init --force
```

### 설정 제거

```bash
# 프로젝트 로컬 hooks 제거
gdc --deinit

# 글로벌 hooks 제거
gdc --deinit --global
```

### 동작 확인

설정 후 Cline에서 아무 작업을 수행하면, 터미널에 로그가 출력됩니다:

```
[gordian-coder:cline] PreToolUse | task=abc123 | data={"tool":"read_file","parameters":{"path":"src/index.ts"}}
```

### bun으로 직접 실행

```bash
# 글로벌 설치 없이 사용
bun run start:cline -- --init

# 또는 직접 실행
bun run src/adapters/cline/cli.ts --init
```

---

## 4. Hook 타입

Cline은 8가지 hook 타입을 지원합니다.

### Task Lifecycle

| Hook | 실행 시점 | 활용 예시 |
|------|-----------|-----------|
| **TaskStart** | 새 태스크 시작 | 프로젝트 컨텍스트 주입, 시작 로깅 |
| **TaskResume** | 중단된 태스크 재개 | 변경사항 확인, 상태 갱신 |
| **TaskCancel** | 태스크 취소 | 임시 파일 정리, 알림 |
| **TaskComplete** | 태스크 성공 완료 | 테스트 실행, CI 트리거 |

### Tool Execution

| Hook | 실행 시점 | 활용 예시 |
|------|-----------|-----------|
| **PreToolUse** | 툴 실행 전 | 위험 명령 차단, 파라미터 검증 |
| **PostToolUse** | 툴 실행 후 | 결과 감사, 성능 모니터링 |

### Conversation

| Hook | 실행 시점 | 활용 예시 |
|------|-----------|-----------|
| **UserPromptSubmit** | 사용자 메시지 전송 | 프롬프트 로깅, 컨텍스트 추가 |
| **PreCompact** | 대화 컨텍스트 축소 전 | 중요 정보 백업, 요약 주입 |

### Input 데이터 구조

모든 hook은 공통 필드를 포함합니다:

```json
{
  "taskId": "abc123",
  "hookName": "PreToolUse",
  "clineVersion": "3.17.0",
  "timestamp": "1736654400000",
  "workspaceRoots": ["/path/to/project"],
  "userId": "user_123",
  "model": {
    "provider": "openrouter",
    "slug": "anthropic/claude-sonnet-4.5"
  }
}
```

각 hook별 추가 필드:

```typescript
// TaskStart / TaskResume / TaskCancel / TaskComplete
{ taskStart: { task: "태스크 설명 문자열" } }

// PreToolUse
{ preToolUse: { tool: "write_to_file", parameters: { path: "src/config.ts", content: "..." } } }

// PostToolUse
{ postToolUse: { tool: "read_file", parameters: {...}, result: "...", success: true, durationMs: 120 } }

// UserPromptSubmit
{ userPromptSubmit: { prompt: "사용자가 입력한 메시지" } }

// PreCompact
{ preCompact: { conversationLength: 45, estimatedTokens: 125000 } }
```

---

## 5. 수동 설정

`--init` 없이 직접 hook 스크립트를 생성할 수 있습니다.

### 디렉토리 구조

```
.clinerules/hooks/      # 프로젝트 로컬
  TaskStart
  PreToolUse
  PostToolUse
  ...
```

### 스크립트 템플릿 (macOS/Linux)

파일명: `.clinerules/hooks/PreToolUse` (확장자 없음)

```bash
#!/usr/bin/env bash
# [gordian-coder:cline] auto-generated hook — do not edit
# Hook: PreToolUse
exec gdc <&0
```

```bash
# 실행 권한 부여 필수
chmod +x .clinerules/hooks/PreToolUse
```

### 스크립트 템플릿 (Windows)

파일명: `.clinerules/hooks/PreToolUse.ps1`

```powershell
# [gordian-coder:cline] auto-generated hook — do not edit
# Hook: PreToolUse
$input = [Console]::In.ReadToEnd()
$input | gdc
```

---

## 6. 커스터마이징

기본 동작은 모든 hook에 대해 로그만 남기고 `{cancel: false}`를 반환합니다. 핸들러를 등록하여 동작을 변경할 수 있습니다.

### 핸들러 등록

`src/adapters/cline/cli.ts`에서 `registerHook`으로 커스텀 핸들러를 추가합니다:

```typescript
import { registerHook } from "../../core/hooks";

// .js 파일 작성 차단
registerHook("PreToolUse", async (event) => {
  const tool = event.preToolUse?.tool;
  const filePath = event.preToolUse?.parameters?.path as string | undefined;

  if (tool === "write_to_file" && filePath?.endsWith(".js")) {
    return {
      cancel: true,
      contextModification: "",
      errorMessage: "TypeScript 프로젝트에서 .js 파일 생성은 허용되지 않습니다. .ts를 사용하세요.",
    };
  }
  return { cancel: false, contextModification: "", errorMessage: "" };
});
```

### 컨텍스트 주입

`contextModification`에 텍스트를 반환하면 Cline 대화에 컨텍스트로 추가됩니다:

```typescript
registerHook("TaskStart", async (event) => {
  return {
    cancel: false,
    contextModification: "이 프로젝트는 TypeScript strict mode를 사용합니다. .js 파일을 생성하지 마세요.",
    errorMessage: "",
  };
});
```

### 여러 핸들러 등록

같은 hook에 여러 핸들러를 등록할 수 있습니다. 결과는 다음 규칙으로 병합됩니다:

| 필드 | 병합 규칙 |
|------|-----------|
| `cancel` | 하나라도 `true`면 `true` (OR) |
| `contextModification` | 모든 값을 `\n`으로 연결 |
| `errorMessage` | 마지막 비어있지 않은 값 |

### HookRegistry 직접 사용

별도 레지스트리를 만들어 독립적으로 관리할 수도 있습니다:

```typescript
import { HookRegistry } from "gordian-coder/core";

const registry = new HookRegistry();
registry.register("PreToolUse", myHandler);
registry.register("PreToolUse", anotherHandler);

const result = await registry.dispatch(event);
```

---

## 7. 트러블슈팅

### Hook이 실행되지 않음

- macOS/Linux: `chmod +x` 확인
  ```bash
  chmod +x .clinerules/hooks/*
  ```
- Cline 설정에서 Hooks 기능이 활성화되어 있는지 확인
- 파일 확장자 확인: macOS/Linux는 확장자 없음, Windows는 `.ps1`

### `gdc` 명령어를 찾을 수 없음

```bash
# bun link로 글로벌 등록
bun link

# 또는 스크립트에서 직접 경로 지정
exec bun run /path/to/gordian-coder/src/adapters/cline/cli.ts <&0
```

### stdout에 JSON 외 내용이 출력됨

- 모든 로그는 `stderr`로 출력됩니다 (`process.stderr.write`)
- `console.log` 사용 금지 — `console.error` 또는 `process.stderr.write` 사용

### Validation 에러

입력 JSON이 스키마에 맞지 않으면 에러 메시지와 함께 `{cancel: false}` 응답을 반환합니다:

```json
{"cancel":false,"contextModification":"","errorMessage":"Validation error: ..."}
```

### 프로세스 타임아웃

Cline은 hook 프로세스에 타임아웃을 적용합니다. 핸들러 로직은 가능한 빠르게 실행되어야 합니다.

---

## 8. 프로토콜 레퍼런스

### Input (stdin → gdc)

```json
{
  "taskId": "string (필수)",
  "hookName": "string (필수, 8가지 중 하나)",
  "clineVersion": "string (필수)",
  "timestamp": "string (필수, unix ms)",
  "workspaceRoots": ["string[] (선택)"],
  "userId": "string (선택)",
  "model": { "provider": "string", "slug": "string" },
  "<hookName in camelCase>": { "...hook별 데이터" }
}
```

### Output (gdc → stdout)

```json
{
  "cancel": false,
  "contextModification": "",
  "errorMessage": ""
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `cancel` | `boolean` | `true`면 작업 중단 |
| `contextModification` | `string` | Cline 대화에 추가할 컨텍스트 |
| `errorMessage` | `string` | cancel 시 사용자에게 표시할 에러 메시지 |

### 유효한 hookName 값

```
TaskStart, TaskResume, TaskCancel, TaskComplete,
PreToolUse, PostToolUse, UserPromptSubmit, PreCompact
```

### 종료 코드

| 코드 | 의미 |
|------|------|
| `0` | 정상 (에러 응답 포함) |
| `1` | 치명적 오류 (stdout에 fallback JSON 출력) |

### 테스트 명령어

```bash
# PreToolUse hook 테스트
echo '{"taskId":"test","hookName":"PreToolUse","clineVersion":"3.17.0","timestamp":"1700000000000","preToolUse":{"tool":"bash","parameters":{"command":"ls"}}}' | gdc

# 기대 출력:
# {"cancel":false,"contextModification":"","errorMessage":""}
```
