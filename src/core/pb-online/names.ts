/** Shared by the plugin workflow and `gdc fico-init`/`fico-check`; kept apart so gdc does not bundle the Java parser. */
export const SKILL_NAME = "pb-fixed-online-code";
export const MCP_SERVER = "fico-mcp";
export const UNIT_TEST_SKILL_NAME = "f-unit-test-code";
export const UNIT_TEST_REQ_SKILL_NAME = "f-unit-test-req";
export const UNIT_TEST_ANALYSIS_SKILL_NAME = "f-unittest-analysis";
export const SKILL_NAMES: readonly string[] = [SKILL_NAME, UNIT_TEST_SKILL_NAME, UNIT_TEST_REQ_SKILL_NAME, UNIT_TEST_ANALYSIS_SKILL_NAME];
