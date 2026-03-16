# Gordian Coder Project

## Project Overview
Multi-platform AI coding assistant plugin for OpenCode, Claude Code, and Cline.

## Tech Stack
- Runtime: Bun
- Language: TypeScript
- Protocol: MCP (Model Context Protocol)
- Key Dependencies: @modelcontextprotocol/sdk, @opencode-ai/plugin, zod

## Project Structure
```
src/
  index.ts          # Main entry point
  adapters/         # Platform-specific adapters (MCP, OpenCode, etc.)
  core/             # Core business logic
```

## Build Commands
- Build: `bun run build`
- Test: `bun test`
- Type check: `bun run typecheck`
- Start MCP server: `bun run start:mcp`

---

## Agent Teams Configuration

This project uses Claude Code Teams for collaborative development.

### Team Structure

| Role | Agent | Responsibilities |
|------|-------|------------------|
| **PM** | `project-manager` | 요구사항 분석, 태스크 분할, 할당, 모니터링 |
| **Architect** | `architect` | 시스템 설계 (성능, 확장성, 보안) |
| **Developer 1** | `developer-1` | TDD 개발, 코드 리뷰 |
| **Developer 2** | `developer-2` | TDD 개발, 코드 리뷰 |
| **Tester** | `tester` | 통합 테스트, QA |
| **Tech Writer** | `tech-writer` | 기술 보고서 작성 |

### Development Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│                      1. REQUIREMENT                              │
│                           ↓                                      │
│              ┌──────────────────────┐                           │
│              │   Project Manager    │                           │
│              │  - Analyze requirements                          │
│              │  - Create & assign tasks                         │
│              └──────────┬───────────┘                           │
│                         ↓                                        │
│              ┌──────────────────────┐                           │
│              │      Architect       │                           │
│              │  - Design solution                               │
│              │  - Define file assignments                       │
│              └──────────┬───────────┘                           │
│                         ↓                                        │
│         ┌───────────────┴───────────────┐                       │
│         ↓                               ↓                        │
│  ┌─────────────┐                 ┌─────────────┐                │
│  │ Developer 1 │                 │ Developer 2 │                │
│  │ (TDD)       │  ──parallel──   │ (TDD)       │                │
│  └──────┬──────┘                 └──────┬──────┘                │
│         │                               │                        │
│         └───────── Code Review ─────────┘                       │
│                         ↓                                        │
│              ┌──────────────────────┐                           │
│              │       Tester         │                           │
│              │  - Integration test                              │
│              └──────────┬───────────┘                           │
│                         ↓                                        │
│              ┌──────────────────────┐                           │
│              │    Tech Writer       │                           │
│              │  - Document results                              │
│              └──────────────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

### Key Rules

1. **File Conflict Prevention**: Each developer works on assigned files only
2. **TDD Mandatory**: Write tests first, then implement
3. **Tests Must Pass**: Never mark task complete with failing tests
4. **Sequential Handoff**: Each phase completes before the next begins
5. **Cross Review**: Developers review each other's code

### Team Invocation Example

```
Create an agent team for this requirement:
- project-manager: analyze and create tasks
- architect: design the solution
- developer-1 and developer-2: implement in parallel
- tester: integration testing
- tech-writer: document results
```

---

## Code Standards
- Use TypeScript strict mode
- Prefer explicit types over inference for public APIs
- Use Zod for runtime validation
- Follow TDD practices
