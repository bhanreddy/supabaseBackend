import http from 'k6/http';
import { check, fail } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const attendanceSubmitDuration = new Trend('attendance_submit_duration', true);
const serverErrorRate = new Rate('attendance_server_errors');

const baseUrl = String(__ENV.API_BASE_URL || '').replace(/\/$/, '');
const allowNonStaging = String(__ENV.ALLOW_NON_STAGING || '').toLowerCase() === 'true';
if (!baseUrl) fail('API_BASE_URL is required');
if (!allowNonStaging && !/stag|test|localhost|127\.0\.0\.1/i.test(baseUrl)) {
  fail('Refusing to run an attendance-writing load test outside staging/test. Set ALLOW_NON_STAGING=true only after explicit review.');
}

let fixtures;
try {
  fixtures = JSON.parse(__ENV.ATTENDANCE_FIXTURES_JSON || '[]');
} catch (error) {
  fail(`ATTENDANCE_FIXTURES_JSON must be valid JSON: ${error.message}`);
}
if (!Array.isArray(fixtures) || fixtures.length < 20) {
  fail('ATTENDANCE_FIXTURES_JSON must contain at least 20 teacher fixtures: [{"token":"...","date":"YYYY-MM-DD","session":"morning"}]');
}

export const options = {
  scenarios: {
    morning_attendance: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 20,
      stages: [
        { target: 25, duration: '1m' },
        { target: 25, duration: '8m' },
        { target: 0, duration: '1m' },
      ],
      gracefulStop: '30s',
    },
  },
  thresholds: {
    'attendance_submit_duration': ['p(95)<350'],
    'attendance_server_errors': ['rate==0'],
    'http_req_failed': ['rate<0.01'],
    'dropped_iterations': ['count==0'],
  },
  noConnectionReuse: false,
  userAgent: 'SchoolIMS-k6-attendance-baseline/1.0',
};

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function parseJson(response, label) {
  try {
    return response.json();
  } catch (_error) {
    fail(`${label} returned non-JSON HTTP ${response.status}`);
  }
}

export default function () {
  const fixture = fixtures[(__VU - 1) % fixtures.length];
  const date = fixture.date || todayUtc();
  const session = fixture.session || 'morning';
  const headers = {
    Authorization: `Bearer ${fixture.token}`,
    'Content-Type': 'application/json',
  };

  const rosterResponse = http.get(
    `${baseUrl}/api/v1/attendance/my-class?date=${encodeURIComponent(date)}&session=${encodeURIComponent(session)}`,
    { headers, tags: { endpoint: 'attendance_roster' } },
  );
  serverErrorRate.add(rosterResponse.status >= 500);
  const rosterOk = check(rosterResponse, {
    'roster returns 200': (response) => response.status === 200,
  });
  if (!rosterOk) return;

  const roster = parseJson(rosterResponse, 'attendance roster')?.data;
  const students = Array.isArray(roster?.students) ? roster.students.slice(0, 40) : [];
  if (!roster?.class_section_id || students.length === 0) {
    fail(`Teacher fixture ${__VU} has no class section or active students`);
  }

  const attendance = students.map((student, index) => ({
    student_id: student.student_id,
    status: index === students.length - 1 ? 'absent' : 'present',
  }));
  const payload = JSON.stringify({
    class_section_id: roster.class_section_id,
    date,
    session,
    attendance,
  });

  const submitResponse = http.post(`${baseUrl}/api/v1/attendance`, payload, {
    headers,
    tags: { endpoint: 'attendance_submit' },
  });
  attendanceSubmitDuration.add(submitResponse.timings.duration);
  serverErrorRate.add(submitResponse.status >= 500);
  check(submitResponse, {
    'attendance submission returns 201': (response) => response.status === 201,
    'attendance response is tenant-enveloped': (response) => {
      const body = parseJson(response, 'attendance submission');
      return body?.success === true && body?.school_id != null;
    },
  });
}
