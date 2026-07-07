import psycopg2
import os

conn = psycopg2.connect(os.environ.get('DATABASE_URL', ''))
conn.autocommit = True
cur = conn.cursor()

parts = [
    "school_id = current_school_id()",
    "is_public = true",
    "created_by = auth.uid()",
    "target_audience = 'all'",
    "auth.role() = 'authenticated'",
    "target_audience = 'staff'",
    "auth_has_role(ARRAY['admin', 'teacher', 'staff', 'accounts'])"
]

print("Testing View Events policy conditions...")
for part in parts:
    try:
        cur.execute(f"SELECT 1 FROM events WHERE {part} LIMIT 1")
        print(f"✅ OK: {part}")
    except Exception as e:
        print(f"❌ ERROR: {part} -> {e}")

conn.close()
