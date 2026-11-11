---
paths:
  - "*-online/src/**"
---

# Project Context (on-stk-ord)

## Base Package
`kr.co.koscom.pb.on.stk.ord`

## Online Module Package Structure
```
src/main/java/kr/co/koscom/pb/on/stk/ord/online/
├── qry/                        # Query (read) operations
│   ├── controller/             # REST controllers
│   ├── service/                # Business logic
│   └── model/vo/               # Request/Response VOs
├── upd/                        # Update (write) operations
│   ├── controller/
│   ├── service/
│   └── model/vo/
├── mapper/                     # MyBatis mapper interfaces (shared across qry/upd)
└── model/dto/                  # DB parameter/result DTOs (shared across qry/upd)

src/main/resources/mapper/
├── oracle/online/              # Oracle SQL XMLs
└── postgres/online/            # PostgreSQL SQL XMLs
```

## Domain Abbreviation
- URL prefix: `/ON`
- Service ID prefix: `SONA` (e.g., SONAQ001, SONAU001)

## MyBatis SQL Location
- Oracle: `src/main/resources/mapper/oracle/online/`
- PostgreSQL: `src/main/resources/mapper/postgres/online/`

## Key Config
- API Docs: SpringDoc OpenAPI (Swagger UI) at `/swagger-ui.html`
- Fixed paging: `fico.fixed-paging.storage` = memory or redis
- Default charset: EUC-KR (`fico.http.default-charset`)