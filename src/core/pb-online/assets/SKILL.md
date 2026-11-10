# pb-fixed-online-code

Generates Controller, Service, and Input/Output VO classes for a new fixed-text online service.
This skill does NOT generate DB Access Layer (Mapper) code.

When generating code, follow the workflow below.
Every file this skill refers to (`rules/*`, `docs/*`, `templates/*`) is included further down in this guide under a heading with its path (rules may also call themselves `.clinerules/*.md`) — do NOT look for them on disk.

### Input Requirements
- **Service ID**: The unique identifier for the online service

## Steps

### 1. Read the Online Code Layer Code Rules
1. Apply the project rules (`rules/fico-overview.md`, `rules/online-dev-guide.md`, `rules/pb-comment-template.md`).
   `rules/online-project-context.md` is an EXAMPLE project (on-stk-ord); take the real package, URL prefix and paths from the Step 3 project analysis.
2. Apply the rule files required for generating Online Processing Layer code:
   - `docs/pb-fixed-vo-rule.md`
   - `docs/pb-fixed-controller-rule.md`
   - `docs/pb-service-rule.md`

### 2. Gathering Prerequisites for Development
1. **IMPORTANT: Replace the placeholders with actual values**
   - Before calling MCP, you MUST replace `{group_name}` and `{program_id}` with real values.
   - DO NOT use the literal strings `{group_name}` / `{program_id}` in the URI.
   - If the group name is not given by the user, look the program up in `fico://all-programs` (or `fico://programs/{group_name}`) to find the group it belongs to.

2. Retrieve the API specification and development metadata from the FICO MCP server by reading the MCP resource `fico://program-detail/{group_name}/{program_id}` (use the MCP resource read tool, e.g. `read_mcp_resource`).
   - The MCP rejects the old form `fico://program-detail/{program_id}`; the group name is mandatory.
   - If the FICO MCP server is not available, STOP and tell the user; never invent the API spec.

3. Analyze the MCP results to extract the API path, data format, description, and API spec (input/output). Apply the following mapping rules:
   - `@PostMapping`: Use the extracted API path as the value attribute.
   - `@Operation`: Use the description for `description`, and generate a concise `summary`.

4. **IMPORTANT: Map API Spec I/O field properties to VO class @FixedData annotation**

### 3. Retrieve Code Templates
1. Reference the templates included below. Select the appropriate template based on the context:

| Template | When to Use |
|----------|-------------|
| `templates/ControllerTemplate.java` | All controller classes |
| `templates/QryServiceTemplate.java` | Service under `qry/service/` |
| `templates/UpdServiceTemplate.java` | Service under `upd/service/` |
| `templates/VoInTemplate.java` | Input VO with PLAIN fields only |
| `templates/VoOutTemplate.java` | Output VO with PLAIN fields only |
| `templates/VoInNestedTemplate.java` | Input VO containing OBJECT or LIST fields (with static inner classes) |
| `templates/VoOutNestedTemplate.java` | Output VO containing OBJECT or LIST fields (with static inner classes) |

### 4. Generate Code
1. Generate code based on the rules, file locations from analysis, and code examples.
2. **CRITICAL - Preserve Existing Code:**
   - NEVER delete existing code in any file being modified.
   - When adding a new method to an existing Controller, preserve all existing methods, imports, annotations, and class structure.
   - When adding new imports, append without removing any existing ones.

### 5. Code Verification and Placeholder Replacements
1. Apply the verification rules from `docs/pb-code-verification-rule.md` to every file you created or modified, and fix any violation before reporting completion.
