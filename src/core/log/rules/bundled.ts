import ERROR_CODE from "./fico_error_code.md" with { type: "text" };
import EXCEPTION_FLOW from "./fico_exception_flow.md" with { type: "text" };
import TRANSACTION from "./fico_transaction.md" with { type: "text" };
import DATASOURCE from "./fico_datasource.md" with { type: "text" };
import MYBATIS from "./fico_mybatis.md" with { type: "text" };
import FIXED_MESSAGE from "./fico_fixed_message.md" with { type: "text" };
import REQUEST_SCOPE from "./fico_request_scope.md" with { type: "text" };
import OUTBOUND from "./fico_outbound.md" with { type: "text" };
import REDIS from "./fico_redis.md" with { type: "text" };
import BATCH from "./fico_batch.md" with { type: "text" };
import DAEMON from "./fico_daemon.md" with { type: "text" };
import WIRING from "./fico_wiring.md" with { type: "text" };
import NPE from "./npe.md" with { type: "text" };

/** Bundled f-log rules as [file, raw md]. ponytail: static imports — adding a
 * rule means adding a line here (same policy as review's BUNDLED_RULES). */
export const BUNDLED: Array<[string, string]> = [
  ["fico_error_code.md", ERROR_CODE],
  ["fico_exception_flow.md", EXCEPTION_FLOW],
  ["fico_transaction.md", TRANSACTION],
  ["fico_datasource.md", DATASOURCE],
  ["fico_mybatis.md", MYBATIS],
  ["fico_fixed_message.md", FIXED_MESSAGE],
  ["fico_request_scope.md", REQUEST_SCOPE],
  ["fico_outbound.md", OUTBOUND],
  ["fico_redis.md", REDIS],
  ["fico_batch.md", BATCH],
  ["fico_daemon.md", DAEMON],
  ["fico_wiring.md", WIRING],
  ["npe.md", NPE],
];
