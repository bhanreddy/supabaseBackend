-- Migration: Add is_temporary_password column to users table
-- This column tracks whether the user is logging in with a temporary password
-- that requires changing before they can access the app.
-- Default TRUE for new records created by super admin, set to FALSE after password change.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_temporary_password BOOLEAN DEFAULT FALSE;

-- Add index for faster lookups on admin users with temporary passwords
CREATE INDEX IF NOT EXISTS idx_users_is_temporary_password 
ON users (is_temporary_password) 
WHERE is_temporary_password = TRUE;
