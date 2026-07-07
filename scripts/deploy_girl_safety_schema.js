import sql from '../db.js';

async function deploySchema() {
  try {

    await sql`
            CREATE TABLE IF NOT EXISTS public.girl_safety_complaints (
                id UUID DEFAULT extensions.uuid_generate_v4() PRIMARY KEY,
                ticket_no VARCHAR(20) UNIQUE NOT NULL,
                student_id UUID REFERENCES public.students(id) ON DELETE SET NULL,
                category VARCHAR(50) NOT NULL,
                description TEXT NOT NULL,
                description_te TEXT,
                incident_date TIMESTAMP WITH TIME ZONE,
                attachments JSONB DEFAULT '[]'::jsonb,
                is_anonymous BOOLEAN DEFAULT false,
                status VARCHAR(20) DEFAULT 'pending',
                assigned_to UUID REFERENCES public.users(id) ON DELETE SET NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                resolved_at TIMESTAMP WITH TIME ZONE
            );
        `;

    await sql`
            CREATE TABLE IF NOT EXISTS public.girl_safety_complaint_threads (
                id UUID DEFAULT extensions.uuid_generate_v4() PRIMARY KEY,
                complaint_id UUID REFERENCES public.girl_safety_complaints(id) ON DELETE CASCADE,
                sender_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
                sender_role VARCHAR(20) NOT NULL,
                message TEXT NOT NULL,
                message_te TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `;

    process.exit(0);
  } catch (error) {

    process.exit(1);
  }
}

deploySchema();