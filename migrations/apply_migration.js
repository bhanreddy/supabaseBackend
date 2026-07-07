
import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

const sql = postgres(process.env.DATABASE_URL);

async function migrate() {
  try {

    await sql`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 
                    FROM information_schema.columns 
                    WHERE table_name = 'class_sections' 
                    AND column_name = 'class_teacher_id'
                ) THEN
                    ALTER TABLE class_sections 
                    ADD COLUMN class_teacher_id UUID REFERENCES staff(id);
                    RAISE NOTICE 'Column class_teacher_id added';
                ELSE
                    RAISE NOTICE 'Column class_teacher_id already exists';
                END IF;
            END $$;
        `;

  } catch (error) {

  } finally {
    await sql.end();
  }
}

migrate();