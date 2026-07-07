
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'timetable_slots' AND column_name = 'room_no') THEN
        ALTER TABLE timetable_slots ADD COLUMN room_no VARCHAR(50);
    END IF;
END $$;
