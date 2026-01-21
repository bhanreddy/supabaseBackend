import fetch from 'node-fetch';

const API_URL = 'http://localhost:3000/api/v1';

async function check() {
    try {
        console.log('Logging in...');
        const loginRes = await fetch(`${API_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'admin@school.com', password: 'password123' })
        });
        const loginData = await loginRes.json();
        const token = loginData.token;

        console.log('Fetching students...');
        const listRes = await fetch(`${API_URL}/students?limit=100`, { headers: { Authorization: `Bearer ${token}` } });
        const list = await listRes.json();

        const students = list.filter(s => s.admission_no.startsWith('ROLL-TEST-'));

        students.sort((a, b) => (a.current_enrollment?.roll_number || 0) - (b.current_enrollment?.roll_number || 0));

        console.log('--- Roll Number Analysis ---');
        students.forEach(s => {
            console.log(JSON.stringify(s, null, 2));
            console.log(`Roll ${s.current_enrollment?.roll_number}: ${s.first_name} ${s.last_name}`);
        });

    } catch (e) {
        console.error(e);
    }
}

check();
