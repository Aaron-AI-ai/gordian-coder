# SQL Query Verification Rule

1. Only SQL queries generated or modified during this operation will be verified.

2. **CRITICAL - DO NOT WRITE TO FILES:**
   - **NEVER write or save the verified SQL to any file**
   - **NEVER use write_to_file, create_file, or any file creation tools**
   - Verification is for display purposes only
   - The user will manually handle file operations if needed

3. **Schema Validation:**
   - Verify all table names exist in the retrieved schema
   - Verify all column names are valid for the referenced tables
   - Verify data types are compatible with the operations

4. **Query Structure Verification:**
   - SELECT: Verify column list, FROM clause, JOIN conditions, WHERE clause
   - INSERT: Verify column list matches VALUES, required columns included
   - UPDATE: Verify SET clause, WHERE clause (prevent full table updates)
   - DELETE: Verify WHERE clause exists (prevent full table deletes)
