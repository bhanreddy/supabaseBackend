import express from 'express';
import sql from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /admin/dashboard-stats
 * Get aggregated statistics for the admin dashboard
 */
router.get('/dashboard-stats', requireAuth, asyncHandler(async (req, res) => {
    // 1. Get Total Students (Using View)
    const [studentCount] = await sql`
        SELECT COUNT(*) as count FROM active_students
    `;

    // 2. Get Staff Stats
    // Total Active Staff
    const [totalStaff] = await sql`
        SELECT COUNT(*) as count FROM staff WHERE status_id = 1 AND deleted_at IS NULL
    `;

    // Staff on Leave Today (Approved leaves covering current date)
    // Note: applicant_id in leaves is user_id. We technically need to map user -> person -> staff.
    // However, for simplicity/performance in dashboard, assuming most leave applicants are staff/teachers.
    // A more precise query would join users/persons/staff, but let's trust the 'leaves' count for now or do a JOIN.
    // Let's do the JOIN for correctness.
    const [staffOnLeave] = await sql`
        SELECT COUNT(DISTINCT la.applicant_id) as count
        FROM leave_applications la
        JOIN users u ON la.applicant_id = u.id
        JOIN staff s ON u.person_id = s.person_id
        WHERE la.status = 'approved'
          AND CURRENT_DATE BETWEEN la.start_date AND la.end_date
    `;

    const activeStaffCount = parseInt(totalStaff.count) || 0;
    const onLeaveCount = parseInt(staffOnLeave.count) || 0;
    const staffPresent = Math.max(0, activeStaffCount - onLeaveCount);

    // 3. Get Complaints Count (Status = 'open')
    const [complaintCount] = await sql`
        SELECT COUNT(*) as count FROM complaints WHERE status = 'open'
    `;

    // 4. Get Collection (Total Fees Paid) from fee_transactions
    const [collection] = await sql`
        SELECT COALESCE(SUM(amount), 0) as total FROM fee_transactions
    `;

    // Optional: Filter collection by current month/year if needed, 
    // but usually "Collection" implies total or YTD. Let's stick to total for now 
    // or maybe Current Month to match "Reports" logic? 
    // The Dashboard usually reflects "Cash in Hand" or "Recent Performance".
    // Let's do "Current Month" Collection to make it more meaningful than lifetime total.
    // Actually, dashboard often shows "Total Revenue". Let's restrict to Current Academic Year or just Total.
    // Given the prompt "make it fully functional", showing Lifetime Collection might be huge.
    // Let's show "Current Month Collection".
    const [monthCollection] = await sql`
         SELECT COALESCE(SUM(amount), 0) as total 
         FROM fee_transactions 
         WHERE date_trunc('month', paid_at) = date_trunc('month', CURRENT_DATE)
    `;

    res.json({
        totalStudents: parseInt(studentCount.count),
        staffPresent: staffPresent,
        totalStaff: activeStaffCount,
        complaints: parseInt(complaintCount.count),
        collection: parseFloat(monthCollection?.total || 0)
    });
}));

export default router;
