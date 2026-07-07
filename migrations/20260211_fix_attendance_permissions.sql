-- Migration: Fix Attendance Permissions
-- Description: Assign attendance permissions to staff and student roles.

DO $$
DECLARE
    staff_role_id UUID;
    student_role_id UUID;
    view_perm_id UUID;
    mark_perm_id UUID;
BEGIN
    -- 1. Get Role IDs
    SELECT id INTO staff_role_id FROM roles WHERE code = 'staff';
    SELECT id INTO student_role_id FROM roles WHERE code = 'student';

    -- 2. Get Permission IDs
    SELECT id INTO view_perm_id FROM permissions WHERE code = 'attendance.view';
    SELECT id INTO mark_perm_id FROM permissions WHERE code = 'attendance.mark';

    -- 3. Assign Staff Permissions
    IF staff_role_id IS NOT NULL THEN
        -- View
        IF view_perm_id IS NOT NULL THEN
            INSERT INTO role_permissions (role_id, permission_id)
            VALUES (staff_role_id, view_perm_id)
            ON CONFLICT DO NOTHING;
        END IF;
        -- Mark
        IF mark_perm_id IS NOT NULL THEN
            INSERT INTO role_permissions (role_id, permission_id)
            VALUES (staff_role_id, mark_perm_id)
            ON CONFLICT DO NOTHING;
        END IF;
    END IF;

    -- 4. Assign Student Permissions
    IF student_role_id IS NOT NULL AND view_perm_id IS NOT NULL THEN
        INSERT INTO role_permissions (role_id, permission_id)
        VALUES (student_role_id, view_perm_id)
        ON CONFLICT DO NOTHING;
    END IF;

END $$;
