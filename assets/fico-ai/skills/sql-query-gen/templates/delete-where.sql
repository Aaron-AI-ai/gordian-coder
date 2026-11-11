-- DELETE statements MUST NOT use `1=1`
DELETE FROM table_name
WHERE id = #{id}
