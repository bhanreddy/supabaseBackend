-- Required global reference rows for a fresh SchoolIMS installation.
-- IDs are stable foreign-key contracts used throughout the application.
INSERT INTO public.genders (id, name) VALUES
  (1, 'Male'), (2, 'Female'), (3, 'Other')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.countries (code, name) VALUES
  ('IN', 'India'), ('US', 'United States'), ('GB', 'United Kingdom'),
  ('AE', 'United Arab Emirates'), ('SA', 'Saudi Arabia'), ('AU', 'Australia')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.religions (id, name) VALUES
  (1, 'Hinduism'), (2, 'Islam'), (3, 'Christianity'), (4, 'Sikhism'),
  (5, 'Buddhism'), (6, 'Jainism'), (7, 'Other')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.blood_groups (id, name) VALUES
  (1, 'A+'), (2, 'A-'), (3, 'B+'), (4, 'B-'),
  (5, 'AB+'), (6, 'AB-'), (7, 'O+'), (8, 'O-')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.student_categories (id, name) VALUES
  (1, 'General'), (2, 'OBC'), (3, 'SC'), (4, 'ST'), (5, 'EWS'),
  (6, 'BC'), (7, 'BC A'), (8, 'BC B'), (9, 'BC C'),
  (10, 'BC D'), (11, 'BC E'), (12, 'OC')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.relationship_types (id, name) VALUES
  (1, 'Father'), (2, 'Mother'), (3, 'Guardian'), (4, 'Sibling'), (5, 'Other')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.student_statuses (id, code, is_terminal) VALUES
  (1, 'active', false), (2, 'graduated', true), (3, 'withdrawn', true),
  (4, 'expelled', true), (5, 'transferred', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.staff_statuses (id, code, name) VALUES
  (1, 'active', 'Active'), (2, 'on_leave', 'On Leave'),
  (3, 'resigned', 'Resigned'), (4, 'terminated', 'Terminated')
ON CONFLICT (id) DO NOTHING;
