-- 20260803_expand_student_categories.sql
-- Ensure every caste/category is a separate selectable row:
-- General, OC, OBC, BC, BC A..BC E, SC, ST, EWS.
-- Renames legacy hyphenated BC-* names to spaced "BC A" style.
-- Idempotent: safe to re-run.

-- Rename BC-A..BC-E → BC A..BC E when the hyphenated form still exists.
UPDATE student_categories SET name = 'BC A' WHERE id = 7  AND name IN ('BC-A', 'BCA', 'BC_A');
UPDATE student_categories SET name = 'BC B' WHERE id = 8  AND name IN ('BC-B', 'BCB', 'BC_B');
UPDATE student_categories SET name = 'BC C' WHERE id = 9  AND name IN ('BC-C', 'BCC', 'BC_C');
UPDATE student_categories SET name = 'BC D' WHERE id = 10 AND name IN ('BC-D', 'BCD', 'BC_D');
UPDATE student_categories SET name = 'BC E' WHERE id = 11 AND name IN ('BC-E', 'BCE', 'BC_E');

-- Also rename by name when ids differ (older tenants).
UPDATE student_categories SET name = 'BC A' WHERE name IN ('BC-A', 'BCA', 'BC_A') AND name <> 'BC A';
UPDATE student_categories SET name = 'BC B' WHERE name IN ('BC-B', 'BCB', 'BC_B') AND name <> 'BC B';
UPDATE student_categories SET name = 'BC C' WHERE name IN ('BC-C', 'BCC', 'BC_C') AND name <> 'BC C';
UPDATE student_categories SET name = 'BC D' WHERE name IN ('BC-D', 'BCD', 'BC_D') AND name <> 'BC D';
UPDATE student_categories SET name = 'BC E' WHERE name IN ('BC-E', 'BCE', 'BC_E') AND name <> 'BC E';

-- Split legacy combined "SC/ST" into SC if still present under id 3.
UPDATE student_categories SET name = 'SC' WHERE id = 3 AND name IN ('SC/ST', 'SC-ST', 'SC & ST');

INSERT INTO student_categories (id, name)
SELECT v.id, v.name
FROM (VALUES
  (1,  'General'),
  (2,  'OBC'),
  (3,  'SC'),
  (4,  'ST'),
  (5,  'EWS'),
  (6,  'BC'),
  (7,  'BC A'),
  (8,  'BC B'),
  (9,  'BC C'),
  (10, 'BC D'),
  (11, 'BC E'),
  (12, 'OC')
) AS v(id, name)
WHERE NOT EXISTS (
  SELECT 1 FROM student_categories sc WHERE sc.id = v.id OR sc.name = v.name
);
