/** Shared by the plugin workflow and `gdc fico-init`/`fico-check`; kept apart so gdc does not bundle the Java parser. */
export const SKILL_NAME = "f-pb-fixed-online-code";
/** Old installed skill directories `gdc fico-init` removes. */
export const RETIRED_SKILL_NAMES: readonly string[] = ["pb-fixed-online-code", "f-unit-test-req"];
export const MCP_SERVER = "fico-mcp";
export const UNIT_TEST_SKILL_NAME = "f-unit-test-code";
export const UNIT_TEST_ANALYSIS_SKILL_NAME = "f-unittest-analysis";
export const SKILL_NAMES: readonly string[] = [SKILL_NAME, UNIT_TEST_SKILL_NAME, UNIT_TEST_ANALYSIS_SKILL_NAME];
