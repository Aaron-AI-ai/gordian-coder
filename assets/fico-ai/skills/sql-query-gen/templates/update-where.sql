-- UPDATE statements MUST NOT use `1=1`
UPDATE table_name
SET column1 = #{value1}
WHERE id = #{id}
