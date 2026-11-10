This workflow orchestrates the generation of FICO PB fixed-text online service code by analyzing user instructions, planning, analyzing existing code, and invoking the `pb_online_code_guide` tool (the `pb-fixed-online-code` skill).

<detailed_sequence_of_steps>

# FICO PB Online Code Generation Workflow

## 1. Instruction Analysis

1. Analyze the user's requirements or contextual information to identify and extract the following specific details: Package Information, Program ID, Target Controller Filename, and Description for Comments.

## 2. Planning

1. Based on the analyzed requirements, create a comprehensive task plan for the code generation workflow.

2. Present the execution plan to the user, then END YOUR TURN and wait for the user's reply:
   ```
   The code generation task will proceed in the following order:

   **Task Plan:**

   **Step 1: Instruction Analysis**
   - Program ID: {extracted_program_id}
   - Target Controller: {target_controller_name}

   **Step 2: Planning**
   - Create task plan for code generation workflow
   - Present execution plan and wait for user confirmation

   **Step 3: Existing Code Analysis**
   - Analyze existing Controller / Service / VO files
   - Determine target files to create or modify

   **Step 4: Code Generation & Verification (via pb-fixed-online-code skill)**
   - Call `pb_online_code_guide` to load the skill, then generate and verify code
   - {ServiceId}In.java (Input VO class)
   - {ServiceId}Out.java (Output VO class)
   - {ServiceId}Service.java (Service class)
   - {Controller}Controller.java (add/modify method)

   Would you like to proceed with this plan? (Enter ok/yes to proceed, or provide modifications)
   ```

3. Wait for user confirmation before proceeding to the next steps. Do NOT read, create or modify any file in the same turn as the plan.

## 3. Code-Based Analysis of Current Project

1. Derive the base path for online code by scanning the project structure:
   - Identify the online module directory: find the module ending with `-online`
   - Identify the base package path: scan `{module_name}-online/src/main/java/` to find the package path containing an `online` directory
   - Set `{online_base_path}` = `{module_name}-online/src/main/java/{base_package}/online`

2. Analyze the filenames related to the online code layer (Controller, Service, VO, DTO, Mapper) in the existing code.
   - Scan `{online_base_path}` for all `qry` and `upd` sub-layers, listing files (recursively) under each directory:
     - `{online_base_path}/{qry|upd}/controller`
     - `{online_base_path}/{qry|upd}/service`
     - `{online_base_path}/{qry|upd}/model/vo`

3. If the target Controller class is not specified by the user, scan the existing controller layer. Analyze whether an existing class file matches the derived API path, description, and Program ID.

4. Based on user instructions or pre-analyzed results, determine whether to add code to an existing file or create a new one.

5. Have the user verify the file name and method name where the code will be generated, then END YOUR TURN and wait for the user's reply:
   ```
   Based on code analysis, the following file location and method name are suggested:

   **Suggested file:** {AI_determined_file_path}
   **Suggested method name:** {AI_determined_method_name}

   Please review this suggestion. You can:
   - Enter "ok" or "yes" to accept
   - Provide a modified path or method name if changes are needed
   ```

## 4. Invoke pb-fixed-online-code Skill

1. Based on the information confirmed in the previous steps, call the `pb_online_code_guide` tool and follow its instructions exactly to generate and verify the code.

</detailed_sequence_of_steps>
