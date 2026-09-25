-- Parents cannot change profile pictures until an administrator enables it.
-- Missing rows are also treated as disabled by the API.
INSERT INTO school_settings (school_id, key, value, updated_at)
SELECT id, 'allow_parent_profile_photo_upload', 'false', NOW()
FROM schools
ON CONFLICT (school_id, key) DO NOTHING;
