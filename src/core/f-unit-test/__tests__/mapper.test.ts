import { describe, expect, test } from "bun:test";
import { mapperDefects, mapperMethods } from "../mapper";

const ACCOUNT_MAPPER = `package kr.co.koscom.pb.on.stk.ord.bsm.mapper;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.session.RowBounds;
import java.util.List;

/**
 * 계좌 Mapper
 */
@Mapper
public interface AccountMapper {

    /** 계좌번호로 조회 */
    AccountResult selectByAccountNo(AccountParameter parameter);

    // List<AccountResult> commentedOut(AccountParameter parameter);
    List<AccountResult> selectAccountList(@Param("p") AccountParameter parameter, RowBounds rowBounds);

    @Options(useGeneratedKeys = true, keyProperty = "id")
    int insert(AccountParameter parameter);

    long countAccountList(@Param("a") String a, @Param("b") Map<String, List<String>> b);

    default String label() { return "x;y(z)"; }

    static AccountMapper none() { return null; }

    <T> T generic(Class<T> type);
}
`;

describe("mapperMethods", () => {
  test("a real-shaped Mapper lists its abstract methods only", () => {
    expect(mapperMethods(ACCOUNT_MAPPER, "AccountMapper.java")).toEqual([
      "selectByAccountNo",
      "selectAccountList",
      "insert",
      "countAccountList",
      "generic",
    ]);
  });

  test("a MyBatis @Mapper interface qualifies whatever its file name (import, wildcard or FQCN)", () => {
    expect(mapperMethods("import org.apache.ibatis.annotations.Mapper;\n@Mapper\npublic interface Foo { int a(); }", "Foo.java")).toEqual(["a"]);
    expect(mapperMethods("import org.apache.ibatis.annotations.*;\n@Mapper\npublic interface Foo { int a(); }", "Foo.java")).toEqual(["a"]);
    expect(mapperMethods("@org.apache.ibatis.annotations.Mapper\npublic interface Foo { int a(); }", "Foo.java")).toEqual(["a"]);
  });

  test("a Mapper-named interface qualifies without @Mapper only in a mapper/repo/repository package", () => {
    for (const pkg of ["x.mapper", "x.repo", "x.y.repository.z"]) {
      expect(mapperMethods(`package ${pkg};\npublic interface FooMapper { int a(); }`, "FooMapper.java")).toEqual(["a"]);
    }
    expect(mapperMethods("package x.util;\npublic interface FooMapper { int a(); }", "FooMapper.java")).toBeNull();
    expect(mapperMethods("public interface FooMapper { int a(); }", "FooMapper.java")).toBeNull();
  });

  test("a MapStruct @Mapper and a util ObjectMapper are not MyBatis Mappers", () => {
    expect(mapperMethods("package x.mapper;\nimport org.mapstruct.Mapper;\n@Mapper\npublic interface DtoMapper { Dto to(Vo v); }", "DtoMapper.java")).toBeNull();
    expect(mapperMethods("package x.mapper;\n@org.mapstruct.Mapper\npublic interface DtoMapper { Dto to(Vo v); }", "DtoMapper.java")).toBeNull();
    expect(mapperMethods("package x.util;\npublic interface ObjectMapper { String write(Object o); }", "ObjectMapper.java")).toBeNull();
    expect(mapperMethods("package x;\n@Mapper\npublic interface Foo { int a(); }", "Foo.java")).toBeNull();
  });

  test("a plain interface, a class and an annotation type are not Mappers", () => {
    expect(mapperMethods("public interface Foo { int a(); }", "Foo.java")).toBeNull();
    expect(mapperMethods("import org.apache.ibatis.annotations.Mapper;\n@Mapper\npublic class FooMapper { int a() { return 1; } }", "FooMapper.java")).toBeNull();
    expect(mapperMethods("import org.apache.ibatis.annotations.Mapper;\n@Mapper public @interface FooMapper { String a(); }", "FooMapper.java")).toBeNull();
  });

  test("annotation-mapped SQL methods keep their names", () => {
    const src = `import org.apache.ibatis.annotations.*;
@Mapper
public interface SqlMapper {
  @Select("SELECT a; FROM t WHERE x = #{x}")
  @Results({@Result(column = "a", property = "a")})
  Row pick(@Param("x") String x);
}`;
    expect(mapperMethods(src, "SqlMapper.java")).toEqual(["pick"]);
  });
});

describe("mapperDefects", () => {
  const check = (called: boolean[], testFile: string | null = "t/AccountMapperTest.java") => ({
    target: "m/AccountMapper.java",
    testFile,
    methods: called.map((c, i) => ({ name: `m${i}`, called: c, skipped: false })),
  });

  test("names the uncalled methods", () => {
    const d = mapperDefects([check([true, false, false])]);
    expect(d).toHaveLength(1);
    expect(d[0]).toContain("m1, m2");
  });

  test("everything called is clean; a skipped method is exempt", () => {
    expect(mapperDefects([check([true, true])])).toEqual([]);
    const c = check([true, false]);
    c.methods[1]!.skipped = true;
    expect(mapperDefects([c])).toEqual([]);
  });

  test("a missing test file is a defect", () => {
    expect(mapperDefects([check([false], null)])[0]).toContain("AccountMapperTest.java");
  });
});
