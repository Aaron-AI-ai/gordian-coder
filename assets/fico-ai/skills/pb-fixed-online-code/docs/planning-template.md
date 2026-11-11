# Planning Template

```
**Step 1: Instruction Analysis** ✓ Complete
- Program ID: {extracted_program_id}
- Target Controller: {target_controller_name}

**Step 2: Read Code Generation Rules**
- VO class generation rules (clinerules-bank/online-code-fixed-vo-en.md)
- Controller layer generation rules (clinerules-bank/online-code-fixed-controller-en.md)
- Service layer generation rules (clinerules-bank/online-code-service-en.md)

**Step 3: Retrieve Development Metadata**
- Fetch API Spec (Input/Output) from FICO MCP server
- Extract API Path, data format, and description

**Step 4: Existing Code Analysis**
- Analyze existing Controller / Service files
- Determine target files to create or modify

**Step 5: Retrieve Code Examples**
- Refer to code template examples in Skill

**Step 6: Code Generation**
- {ServiceId}In.java (Input VO class)
- {ServiceId}Out.java (Output VO class)
- {ServiceId}Service.java (Service class)
- {Controller}Controller.java (add/modify method)

**Step 7: Code Verification**
- Required annotations verification
- Controller Input / Output class type verification
- Service layer pattern verification
- Overall code quality verification
```