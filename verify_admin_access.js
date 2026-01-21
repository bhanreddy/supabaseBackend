import fetch from 'node-fetch';

const API_URL = 'http://localhost:3000/api/v1';

async function test() {
    try {
        console.log('--- TESTING ADMIN ---');
        // 1. ADMIN LOGIN
        const adminLogin = await fetch(`${API_URL}/auth/login`, {
            method: 'POST',
            body: JSON.stringify({ email: 'admin@school.com', password: 'password123' }),
            headers: { 'Content-Type': 'application/json' }
        });
        const adminData = await adminLogin.json();

        if (!adminData.token) {
            console.error('Admin Login Failed:', adminData);
            return;
        }
        console.log('Admin Token received.');

        // 2. ADMIN GET /students
        const adminListRes = await fetch(`${API_URL}/students?limit=1`, {
            headers: { Authorization: `Bearer ${adminData.token}` }
        });

        if (adminListRes.status === 200) {
            console.log('✅ Admin can access GET /students');
        } else {
            console.log(`❌ Admin BLOCKED on GET /students: ${adminListRes.status}`);
        }

        // 3. ADMIN GET /profile/me
        const adminMeRes = await fetch(`${API_URL}/students/profile/me`, {
            headers: { Authorization: `Bearer ${adminData.token}` }
        });
        console.log(`Admin GET /profile/me Status: ${adminMeRes.status}`);
        const adminMeText = await adminMeRes.text();
        console.log(`Admin GET /profile/me Body: ${adminMeText.substring(0, 200)}`); // Log first 200 chars

        // 4. TEST STUDENT (Aaron)
        console.log('\n--- TESTING STUDENT ---');
        const tempEmail = `test.student.${Date.now()}@school.com`;

        console.log(`Creating student: ${tempEmail}`);
        const createRes = await fetch(`${API_URL}/students`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminData.token}` },
            body: JSON.stringify({
                first_name: 'Test', last_name: 'Access',
                admission_no: `TEST-${Date.now()}`,
                admission_date: '2025-01-01',
                gender_id: 1, status_id: 1,
                email: tempEmail,
                password: 'password123',
                class_id: 'c87a4b08-6202-4217-8051-738b5558d745',
                section_id: 'c4e09a34-7221-4475-8167-33f789958349',
                academic_year_id: 'a9b223c6-30e4-41d1-9f93-5188339c6374'
            })
        });

        if (createRes.status !== 201) {
            console.log(`Skipping Student Login Test (Creation failed: ${createRes.status})`);
            const err = await createRes.text();
            console.log(err);
        } else {
            const studentLogin = await fetch(`${API_URL}/auth/login`, {
                method: 'POST',
                body: JSON.stringify({ email: tempEmail, password: 'password123' }),
                headers: { 'Content-Type': 'application/json' }
            });
            const studentData = await studentLogin.json();

            if (studentData.token) {
                // Attempt GET /students (Should Fail)
                const studentListRes = await fetch(`${API_URL}/students?limit=1`, {
                    headers: { Authorization: `Bearer ${studentData.token}` }
                });
                if (studentListRes.status === 403) {
                    console.log('✅ Student correctly BLOCKED on GET /students (403)');
                } else {
                    console.log(`❌ Student access UNEXPECTED on GET /students: ${studentListRes.status}`);
                }

                // Attempt GET /profile/me (Should Succeed)
                const meRes = await fetch(`${API_URL}/students/profile/me`, {
                    headers: { Authorization: `Bearer ${studentData.token}` }
                });
                console.log(`Student GET /profile/me Status: ${meRes.status}`);
                const meText = await meRes.text();
                console.log(`Student GET /profile/me Body: ${meText.substring(0, 200)}`);
            }
        }

    } catch (e) {
        console.error(e);
    }
}

test();
