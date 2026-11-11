-- SELECT statements MUST include `1=1` condition in WHERE clause
SELECT column1, column2
FROM table_name
WHERE 1=1
  AND column1 = #{value1}
  AND column2 = #{value2}
