---
paths:
  - "*-online/src/**"
---

# Online Module Development Guide

## Architecture
All online services MUST follow the **Controller → Service → Mapper** layered architecture. Each layer has a single responsibility:
- **Controller**: HTTP endpoint mapping and request/response delegation only — no business logic, no direct DB access
- **Service**: Business logic and transaction management
- **Mapper**: Database access via MyBatis interfaces and XML queries

Do NOT bypass layers (e.g., calling a Mapper directly from a Controller).

### Javadoc Format

> Refer to [pb-comment-template.md](pb-comment-template.md) (`.clinerules/pb-comment-template.md`) for the standard comment template.


## Package Structure

> For package structure, project-specific paths, and config details, see [online-project-context.md](online-project-context.md) (`.clinerules/online-project-context.md`).

## MyBatis SQL Location

> For SQL paths and config, see [online-project-context.md](online-project-context.md) (`.clinerules/online-project-context.md`).