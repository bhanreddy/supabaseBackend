-- Normalize junk optional name literals (Null, null, None, undefined, whitespace) to SQL NULL
-- on persons.middle_name and persons.last_name. Covers students, staff, teachers, parents.

CREATE OR REPLACE FUNCTION normalize_optional_name()
RETURNS TRIGGER
SET search_path = public
AS $$
BEGIN
  NEW.middle_name := NULLIF(TRIM(COALESCE(NEW.middle_name, '')), '');
  IF NEW.middle_name IS NOT NULL
     AND LOWER(NEW.middle_name) IN ('null', 'none', 'undefined') THEN
    NEW.middle_name := NULL;
  END IF;

  NEW.last_name := NULLIF(TRIM(COALESCE(NEW.last_name, '')), '');
  IF NEW.last_name IS NOT NULL
     AND LOWER(NEW.last_name) IN ('null', 'none', 'undefined') THEN
    NEW.last_name := NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_normalize_person_optional_names ON persons;
CREATE TRIGGER trg_normalize_person_optional_names
BEFORE INSERT OR UPDATE ON persons
FOR EACH ROW EXECUTE FUNCTION normalize_optional_name();
