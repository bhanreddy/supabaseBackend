-- 20260614_add_bc_student_categories.sql
-- Add Backward Class categories (Telangana/AP): plain BC plus sub-categories BC A..BC E.
-- General(1), SC(3) and ST(4) already exist; OBC(2) and EWS(5) are left intact.
-- Idempotent: guarded on both id and name so re-running is a no-op.
-- Note: names use spaced form ("BC A"); see 20260803_expand_student_categories.sql for rename + OC.
INSERT INTO student_categories (id, name)
SELECT v.id, v.name
FROM (VALUES
  (6,  'BC'),
  (7,  'BC A'),
  (8,  'BC B'),
  (9,  'BC C'),
  (10, 'BC D'),
  (11, 'BC E')
) AS v(id, name)
WHERE NOT EXISTS (
  SELECT 1 FROM student_categories sc WHERE sc.id = v.id OR sc.name = v.name
);
