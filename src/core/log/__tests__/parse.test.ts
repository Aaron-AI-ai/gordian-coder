import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStackTrace, stripLinePrefix, normalizeClass, normalizeMethod } from "../parse";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

const PB_ONLINE = `[ERROR:a1b2c3:user01][host1:2026-07-01 15:32:08.194][http-nio-8080-exec-1][ext.aspect.PBExceptionHandlerAspect:handleFixedLengthException:59] 고정길이 전문 CommonException: errorCode=1001
kr.co.koscom.pb.framework.site.ext.exception.PBOnlineException
	at kr.co.koscom.pb.on.stk.ord.online.qry.service.SONAQ001Service.query(SONAQ001Service.java:41) [main/:?]
	at kr.co.koscom.pb.on.stk.ord.online.qry.service.SONAQ001Service$$SpringCGLIB$$0.query(<generated>) [main/:?]
	at org.springframework.aop.framework.CglibAopProxy$CglibMethodInvocation.proceed(CglibAopProxy.java:765) ~[spring-aop-6.2.14.jar:6.2.14]
	at kr.co.koscom.pb.framework.site.ext.aspect.PBTransactionAspect.manageTransaction(PBTransactionAspect.java:71) ~[framework-site-ext-1.0.0.jar:?]
	at kr.co.koscom.pb.on.stk.ord.online.qry.controller.SONAQ001Controller.sonaq001(SONAQ001Controller.java:72) [main/:?]
	at kr.co.koscom.pb.on.stk.ord.online.qry.controller.SONAQ001Controller.lambda$sonaq001$0(SONAQ001Controller.java:80) [main/:?]
	at java.base/java.util.Optional.map(Optional.java:260) ~[?:?]
`;

describe("parseStackTrace", () => {
  test("real fico startup log: chain, omitted restore, suffix stripping, module prefix", () => {
    const p = parseStackTrace(fixture("startup-jmx.log"));
    expect(p.chain).toHaveLength(2);
    expect(p.chain[0].type).toBe("org.springframework.beans.factory.BeanCreationException");
    expect(p.chain[0].message).toContain("MBean export failed");
    expect(p.chain[0].frames).toHaveLength(15);
    expect(p.chain[0].frames[2]).toMatchObject({ cls: "java.util.HashMap", method: "forEach", file: "HashMap.java", line: 1429 });
    expect(p.chain[0].frames[14]).toMatchObject({ cls: "kr.co.fico.framework.FicoAppExampleApplication", method: "main", line: 12 });
    const root = p.chain[1];
    expect(root.type).toBe("javax.management.InstanceAlreadyExistsException");
    expect(root.omitted).toBe(14);
    expect(root.frames).toHaveLength(10 + 14); // own frames + restored tail of the enclosing block
    expect(root.frames[23].cls).toBe("kr.co.fico.framework.FicoAppExampleApplication");
    expect(p.handler.logger).toBe("org.springframework.boot.SpringApplication");
  });

  test("fico handler line: errorCode extracted, messageless header, CGLIB + lambda normalized", () => {
    const p = parseStackTrace(PB_ONLINE);
    expect(p.handler.errorCode).toBe("1001");
    expect(p.chain).toHaveLength(1);
    expect(p.chain[0].type).toBe("kr.co.koscom.pb.framework.site.ext.exception.PBOnlineException");
    expect(p.chain[0].message).toBe("");
    expect(p.chain[0].frames[1].cls).toBe("kr.co.koscom.pb.on.stk.ord.online.qry.service.SONAQ001Service");
    expect(p.chain[0].frames[1].file).toBeNull();
    expect(p.chain[0].frames[5].method).toBe("sonaq001");
  });

  test("stack-less PBGlobalExceptionAdvice warn line → synthesized block with 0 frames", () => {
    const p = parseStackTrace(
      "[WARN :t1:u1][h:2026-07-01 10:00:00.000][exec-2][ext.aspect.PBGlobalExceptionAdvice:handleCommonException:201] PB CommonException: URI=/ON/SONAQ001, code=1002, msg=null\n"
    );
    expect(p.handler).toMatchObject({ errorCode: "1002", uri: "/ON/SONAQ001" });
    expect(p.chain).toHaveLength(1);
    expect(p.chain[0].type).toBe("kr.co.openlabs.fico.framework.exception.CommonException");
    expect(p.chain[0].frames).toHaveLength(0);
  });

  test("stack-less PB 9604/404 handler lines synthesize a typed 0-frame block (I-1)", () => {
    const p9604 = parseStackTrace(
      "[WARN :t:u][h:2026-07-01 10:00:00.000][exec-2][ext.aspect.PBGlobalExceptionAdvice:handleMessageNotReadable:175] PB 9604: URI=/ON/SONAQ001, error=bad length\n"
    );
    expect(p9604.handler.errorCode).toBe("9604");
    expect(p9604.handler.uri).toBe("/ON/SONAQ001");
    expect(p9604.chain).toHaveLength(1);
    expect(p9604.chain[0].type).toBe("org.springframework.http.converter.HttpMessageNotReadableException");
    expect(p9604.chain[0].frames).toHaveLength(0);

    const p404 = parseStackTrace(
      "[WARN :t:u][h:2026-07-01 10:00:00.000][exec-2][ext.aspect.PBGlobalExceptionAdvice:handleNoHandlerFound:180] PB 404: URI=/x\n"
    );
    expect(p404.chain).toHaveLength(1);
    expect(p404.chain[0].type).toBe("org.springframework.web.servlet.NoHandlerFoundException");
    expect(p404.chain[0].frames).toHaveLength(0);
  });

  test("CommonControllerAdvice Exception:[FQCN: msg] one-liner followed by the trace", () => {
    const p = parseStackTrace(
      "[ERROR::][2026-03-26 15:47:19.160] [http-nio-8090-exec-1] [fico.framework.extension.aspect.CommonControllerAdvice:handleException:67] Exception:[org.springframework.web.servlet.resource.NoResourceFoundException: No static resource swagger-ui.]\n" +
        "org.springframework.web.servlet.resource.NoResourceFoundException: No static resource swagger-ui.\n" +
        "\tat org.springframework.web.servlet.resource.ResourceHttpRequestHandler.handleRequest(ResourceHttpRequestHandler.java:586) ~[spring-webmvc-6.1.17.jar:6.1.17]\n"
    );
    expect(p.chain).toHaveLength(1);
    expect(p.chain[0].frames).toHaveLength(1);
    expect(p.handler.exceptionType).toBe("org.springframework.web.servlet.resource.NoResourceFoundException");
  });

  test("legacy '; nested exception is' splits into a cause block", () => {
    const p = parseStackTrace(
      "org.springframework.dao.DataIntegrityViolationException: could not execute; nested exception is java.sql.SQLIntegrityConstraintViolationException: ORA-00001: unique constraint (PB.UK1) violated\n" +
        "\tat org.springframework.jdbc.support.SQLErrorCodeSQLExceptionTranslator.doTranslate(SQLErrorCodeSQLExceptionTranslator.java:251)\n"
    );
    expect(p.chain).toHaveLength(2);
    expect(p.chain[0].message).toBe("could not execute");
    expect(p.chain[1].type).toBe("java.sql.SQLIntegrityConstraintViolationException");
    expect(p.chain[1].message).toContain("ORA-00001");
  });

  test("a following prefixed log line ends the trace instead of polluting the message (I-3)", () => {
    const p = parseStackTrace(
      'java.lang.NullPointerException: Cannot invoke "x" because "y" is null\n' +
        "\tat a.B.c(B.java:1)\n" +
        "[INFO :t:u][h:2026-07-01 10:00:00.000][exec-1][k.c.Other:go:1] request completed in 12ms\n"
    );
    expect(p.chain[0].message).toBe('Cannot invoke "x" because "y" is null');
    expect(p.handler.logger).toBeUndefined();
  });

  test("multi-line message and Suppressed", () => {
    const p = parseStackTrace(
      "java.lang.IllegalStateException: pool stats\n, borrowedCount=0, returnedCount=0\n\tat a.b.C.d(C.java:1)\nSuppressed: java.io.IOException: closed\n\tat a.b.C.close(C.java:9)\n"
    );
    expect(p.chain[0].message).toBe("pool stats\n, borrowedCount=0, returnedCount=0");
    expect(p.suppressed).toHaveLength(1);
    expect(p.suppressed[0].type).toBe("java.io.IOException");
  });

  test("Kafka consumer log line and 'Exception in thread' header", () => {
    const p = parseStackTrace(
      "[ERROR::][h:2026-07-02 09:00:00.000][kafka-consumer-1][framework.kafka.runnable.DefaultKafkaConsumerRunnable:run:99] Consumer.listen() consumerRecord=ConsumerRecord(topic = ord, partition = 0)\n" +
        'Exception in thread "kafka-consumer-1" kr.co.koscom.pb.framework.site.ext.exception.PBDaemonException: bad payload\n' +
        "\tat kr.co.koscom.pb.on.stk.ord.daemon.OrdConsumer.listen(OrdConsumer.java:33)\n"
    );
    expect(p.chain[0].type).toBe("kr.co.koscom.pb.framework.site.ext.exception.PBDaemonException");
    expect(p.chain[0].message).toBe("bad payload");
  });

  test("JDK lambda frame keeps its class (I-2)", () => {
    const p = parseStackTrace(
      "java.lang.NullPointerException: x\n" +
        "\tat kr.co.koscom.pb.on.stk.ord.online.qry.service.SONAQ001Service$$Lambda$14/0x0000000800c0a208.accept(Unknown Source)\n"
    );
    expect(p.chain[0].frames[0]).toMatchObject({
      cls: "kr.co.koscom.pb.on.stk.ord.online.qry.service.SONAQ001Service",
      method: "accept",
      file: null,
    });
  });

  test("helpers", () => {
    expect(stripLinePrefix("[INFO ::][h:2026-01-01 00:00:00.000][main][a.b.C:m:1] hello").text).toBe("hello");
    expect(stripLinePrefix("2026-01-01 00:00:00.000  INFO 1 --- [main] a.b.C : hello").text).toBe("hello");
    expect(normalizeClass("a.B$$EnhancerBySpringCGLIB$$1f2e")).toBe("a.B");
    expect(normalizeClass("a.B$$SpringCGLIB$$0")).toBe("a.B");
    expect(normalizeClass("a.B$$FastClassBySpringCGLIB$$9")).toBe("a.B");
    expect(normalizeClass("a.B$Inner")).toBe("a.B$Inner");
    expect(normalizeMethod("lambda$save$3")).toBe("save");
    expect(normalizeMethod("<init>")).toBe("<init>");
  });
});
