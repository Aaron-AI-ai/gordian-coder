# FICO Project Rules

## Purpose
Enterprise financial system built on FICO Framework (Java 21 + Spring Boot 3.4).

## Financial System Principles
- **Data integrity**: Every transaction must be atomic — partial failure is not acceptable
- **Transaction safety**: Exceptions must never be silently swallowed in transactional context
- **Input validation**: All external input must be validated at service boundary before processing
- **Concurrency safety**: Duplicate and double processing must be prevented

## Technology Stack

- **Runtime**: Java 21, Spring Boot 3.4, Gradle 8.6
- **ORM**: MyBatis (XML-based SQL only)
- **Logging**: Log4j2 (Spring Boot default Logback is explicitly excluded)
- **DB**: Oracle, PostgreSQL
- **Monitoring**: Micrometer, Prometheus, Actuator

For exact library versions, refer to `build.gradle` and each submodule's `build.gradle`.

## Standard Module Structure

Project follows a multi-module Gradle structure with the pattern `{project-name}-{module}`:

| Module | Type | Role |
|--------|------|------|
| `*-common` | Library | Shared VOs, DTOs, constants, configs, cross-module business logic |
| `*-online` | Executable | REST API services (query/update) |
| `*-batch` | Executable | Spring Batch jobs (chunk, partition, tasklet) |
| `*-daemon` | Executable | Async message processing (Timer / Queue) |

- `*-common` publishes an `api` JAR containing only `model/**` and `module/*` (excluding `module/impl/**`)

For module-specific development guides, read:
- `.clinerules/online-dev-guide.md` — Online service development

## Build & Run

```bash
# Full build
./gradlew clean build -x test

# Test
./gradlew :{module}:test
./gradlew :{module}:test -Dtest.profile=<profile-name>   # specify test profile
```

For module-specific run commands, see each module's development guide.

## FICO Rules (all modules)

1. **Service**: All business logic lives in Service layer, annotated with `@Transactional`
2. **Mapper**: Interface only — SQL must be in MyBatis XML (annotation-based queries prohibited)
3. **MyBatis XML location**: SQL XML files reside in `src/main/resources/mapper/{oracle|postgres}/{module}/`, separated by DB vendor and selected at runtime via Spring Profile
4. **VO** (`model.vo`): API-layer request/response objects; **DTO** (`model.dto`): DB-layer parameter/result objects
5. **Javadoc**: Service class/method and Mapper interface/method must have Javadoc in Korean. Controller and VO/DTO are optional.
