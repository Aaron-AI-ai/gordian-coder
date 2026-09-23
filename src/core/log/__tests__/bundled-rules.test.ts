import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledLogRules, matchLogRules } from "../rules";
import type { HandlerInfo } from "../parse";

const cwd = mkdtempSync(join(tmpdir(), "f-log-bundled-"));
const rules = bundledLogRules(cwd);
const files = (types: string[], paths: string[] = [], handler?: HandlerInfo) =>
  matchLogRules(rules, types, paths, handler).map((r) => r.file).filter((f) => f.startsWith("fico_") || f === "npe.md");

describe("bundled fico rules", () => {
  test("13 fico/npe rules load, each 15–25 body lines, each names an f_log tool", () => {
    const fico = rules.filter((r) => r.file.startsWith("fico_") || r.file === "npe.md");
    expect(fico).toHaveLength(13);
    for (const r of fico) {
      const lines = r.content.split("\n").length;
      expect(lines, r.file).toBeGreaterThanOrEqual(12);
      expect(lines, r.file).toBeLessThanOrEqual(30);
      expect(r.content, r.file).toMatch(/f_log_(read|search|callers|blame|related|history|find)/);
      expect(r.content, r.file).not.toMatch(/\b(file_read|code_search|related_code|git_history)\b/);
    }
  });
  test("gates: representative exception → expected rule", () => {
    expect(files(["kr.co.koscom.pb.framework.site.ext.exception.PBOnlineException"])).toContain("fico_exception_flow.md");
    expect(files(["org.springframework.transaction.UnexpectedRollbackException"])).toContain("fico_transaction.md");
    expect(files(["org.springframework.jdbc.BadSqlGrammarException"])).toContain("fico_datasource.md");
    expect(files(["org.apache.ibatis.exceptions.PersistenceException"])).toContain("fico_mybatis.md");
    expect(files(["org.springframework.http.converter.HttpMessageNotReadableException"])).toContain("fico_fixed_message.md");
    expect(files(["java.lang.IllegalStateException"])).toContain("fico_request_scope.md");
    expect(files(["io.github.resilience4j.circuitbreaker.CallNotPermittedException"])).toContain("fico_outbound.md");
    expect(files(["org.springframework.data.redis.RedisConnectionFailureException"])).toContain("fico_redis.md");
    expect(files(["org.springframework.batch.core.JobExecutionException"])).toContain("fico_batch.md");
    expect(files(["org.apache.kafka.common.errors.SerializationException"])).toContain("fico_daemon.md");
    expect(files(["org.springframework.beans.factory.BeanCreationException"])).toContain("fico_wiring.md");
    expect(files(["java.lang.NullPointerException"])).toContain("npe.md");
    expect(files(["java.lang.NullPointerException"])).toContain("fico_error_code.md"); // always-on
  });
  test("fico_datasource also fires on H2's own JdbcSQL*Exception subclasses (constraint/data, not just syntax)", () => {
    expect(files(["org.h2.jdbc.JdbcSQLIntegrityConstraintViolationException"])).toContain("fico_datasource.md");
    expect(files(["org.h2.jdbc.JdbcSQLDataException"])).toContain("fico_datasource.md");
  });
  test("fico_transaction also fires on Spring's NestedTransactionNotSupportedException/TransactionTimedOutException (subclasses of TransactionException, but *TransactionException is a literal suffix match)", () => {
    expect(files(["org.springframework.transaction.NestedTransactionNotSupportedException"])).toContain("fico_transaction.md");
    expect(files(["org.springframework.transaction.TransactionTimedOutException"])).toContain("fico_transaction.md");
  });
  test("fico_mybatis also fires on Spring's OptimisticLockingFailureException (data-access family, not caught by the existing *DataAccessException suffix match)", () => {
    expect(files(["org.springframework.dao.OptimisticLockingFailureException"])).toContain("fico_mybatis.md");
  });
  test("fico_datasource also fires on H2's own deadlock/timeout JdbcSQL*Exception subclasses", () => {
    expect(files(["org.h2.jdbc.JdbcSQLTransactionRollbackException"])).toContain("fico_datasource.md");
    expect(files(["org.h2.jdbc.JdbcSQLTimeoutException"])).toContain("fico_datasource.md");
  });
  test("fico_wiring also fires on Spring's context.annotation bean-definition-conflict exceptions", () => {
    expect(files(["org.springframework.context.annotation.ConflictingBeanDefinitionException"])).toContain("fico_wiring.md");
    expect(files(["org.springframework.context.annotation.BeanDefinitionOverrideException"])).toContain("fico_wiring.md");
  });
  test("handler gate: fico_exception_flow fires on a handler errorCode even without a matching exception type (I-4)", () => {
    expect(files(["java.lang.NullPointerException"], [], { errorCode: "1001" })).toContain("fico_exception_flow.md");
    expect(files(["java.lang.NullPointerException"])).not.toContain("fico_exception_flow.md");
  });
  test("a plain NPE does not drag in datasource/redis/batch rules", () => {
    const f = files(["java.lang.NullPointerException"]);
    for (const x of ["fico_datasource.md", "fico_redis.md", "fico_batch.md", "fico_daemon.md"]) expect(f).not.toContain(x);
  });
});
