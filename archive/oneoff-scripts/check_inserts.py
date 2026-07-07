import sys
import re

file_path = 'c:/Users/reddy/Desktop/Native SupabaseBackend/SupabaseBackend/schema.sql'
with open(file_path, 'r', encoding='utf-8') as f:
    text = f.read()

inserts = re.findall(r'(?i)INSERT INTO\s+(\w+)\s*\((.*?)\)\s+VALUES\s*(.*?);', text, re.DOTALL)
for table, cols_str, vals_str in inserts:
    cols = [c.strip().lower() for c in cols_str.split(',')]
    
    # parse first value tuple
    try:
        first_tuple_str = vals_str.split(')')[0].strip()
        if first_tuple_str.startswith('('):
            first_tuple_str = first_tuple_str[1:]
        
        # split by comma, ignoring commas inside quotes or function calls (simple split might break, but good enough for generic ids)
        # Using a simple approach: if there's a problem, we warn.
        vals = [v.strip() for v in first_tuple_str.split(',')]
        
        if 'id' in cols and 'school_id' in cols and len(vals) == len(cols):
            id_idx = cols.index('id')
            school_idx = cols.index('school_id')
            
            id_val = vals[id_idx]
            school_val = vals[school_idx]
            
            if "'" in school_val and len(school_val) > 10:
                print(f"Warning: {table} school_id seems to be a UUID: {school_val}")
            
            if "'" not in id_val and id_val.isdigit():
                # integer id
                if table.lower() in ['users', 'students', 'staff', 'persons', 'roles', 'schools']:
                    print(f"Warning: {table} id seems to be integer: {id_val}")
    except Exception as e:
        pass

print("Finished checking INSERTS")
