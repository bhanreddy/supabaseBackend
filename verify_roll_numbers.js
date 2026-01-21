import fetch from 'node-fetch';

const API_URL = 'http://localhost:3000/api/v1';

async function verify() {
    try {
        console.log('1. Logging in...');
        const loginRes = await fetch(`${API_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'admin@school.com', password: 'password123' })
        });
        const loginData = await loginRes.json();
        const token = loginData.token;

        console.log('2. Fetching reference data...');
        const yearsRes = await fetch(`${API_URL}/academics/academic-years`, { headers: { Authorization: `Bearer ${token}` } });
        const years = await yearsRes.json();
        const yearId = years[0].id; // Use current year

        const classesRes = await fetch(`${API_URL}/academics/classes`, { headers: { Authorization: `Bearer ${token}` } });
        const classes = await classesRes.json();
        const classId = classes[0].id;

        const sectionsRes = await fetch(`${API_URL}/academics/sections`, { headers: { Authorization: `Bearer ${token}` } });
        const sections = await sectionsRes.json();
        const sectionId = sections[0].id;

        console.log(`Using Class: ${classes[0].name}, Section: ${sections[0].name}`);

        const createStudent = async (first, last) => {
            const data = {
                first_name: first,
                last_name: last,
                gender_id: 1,
                admission_no: `ROLL-TEST-${first}-${Date.now()}`,
                admission_date: '2025-01-01',
                status_id: 1,
                class_id: classId,
                section_id: sectionId,
                academic_year_id: yearId,
                password: 'password123'
            };
            const res = await fetch(`${API_URL}/students`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify(data)
            });
            return res.json();
        };

        console.log('3. Creating Aaron...');
        await createStudent('Aaron', 'Test');

        console.log('4. Creating Zack...');
        await createStudent('Zack', 'Test');

        console.log('5. Creating Bobby...');
        await createStudent('Bobby', 'Test');

        console.log('6. Verifying Order...');
        // Only fetch students for this class/section? 
        // Our GET /students supports search, but not filtering by class yet via params (implementation plan mentioned adding it but I strictly prioritized roll recalc).
        // Let's rely on internal list logic or just fetch all and filter client side for verification.
        const listRes = await fetch(`${API_URL}/students?limit=100`, { headers: { Authorization: `Bearer ${token}` } });
        const list = await listRes.json();

        // Filter by our created admission numbers prefix 'ROLL-TEST-'
        const students = list.filter(s => s.admission_no.startsWith('ROLL-TEST-'));

        students.sort((a, b) => a.current_enrollment.roll_number - b.current_enrollment.roll_number);

        console.log('--- Roll Number Analysis ---');
        students.forEach(s => {
            console.log(`Roll ${s.current_enrollment.roll_number}: ${s.first_name} ${s.last_name}`);
        });

        // Simple Assertion
        const names = students.map(s => s.first_name);
        // Expect Aaron, Bobby, Zack (roughly, depending on other test data in same section)
        // Since we are using the first class/section, there might be other students there.
        // But our new students should be consistent relative to each other.

        const aaron = students.find(s => s.first_name === 'Aaron');
        const bobby = students.find(s => s.first_name === 'Bobby');
        const zack = students.find(s => s.first_name === 'Zack');

        if (aaron && bobby && zack) {
            if (aaron.current_enrollment.roll_number < bobby.current_enrollment.roll_number &&
                bobby.current_enrollment.roll_number < zack.current_enrollment.roll_number) {
                console.log('✅ SUCCESS: Roll numbers are alphabetical!');
            } else {
                console.log('❌ FAILURE: Order is incorrect.');
            }
        } else {
            console.log('⚠️ Could not find all test students.');
        }

    } catch (e) {
        console.error(e);
    }
}

verify();
