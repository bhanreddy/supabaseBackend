-- Make student/person last_name optional (stored on persons, not students).
ALTER TABLE persons ALTER COLUMN last_name DROP NOT NULL;
