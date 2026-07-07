-- Assign Arun Kura (STF001) as Class Teacher for 10th A
UPDATE class_sections 
SET class_teacher_id = (SELECT id FROM staff WHERE staff_code = 'STF001')
WHERE id = '6f891673-8d9a-4e6f-8519-d5363df86406';

-- Verify update
SELECT cs.id, st.staff_code, p.display_name as teacher_name
FROM class_sections cs
JOIN staff st ON cs.class_teacher_id = st.id
JOIN persons p ON st.person_id = p.id
WHERE cs.id = '6f891673-8d9a-4e6f-8519-d5363df86406';
