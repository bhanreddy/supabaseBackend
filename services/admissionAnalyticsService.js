import sql from '../db.js';

/**
 * Compute admission funnel, capacity, source, and SLA analytics for school management.
 */
export async function getAdmissionAnalytics(schoolId, academicYearId = null) {
  // 1. Core Funnel Counts
  const [funnel] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE true) as total_applications,
      COUNT(*) FILTER (WHERE status = 'APPLICATION_STARTED') as draft_applications,
      COUNT(*) FILTER (WHERE status NOT IN ('APPLICATION_STARTED', 'APPLICATION_INCOMPLETE')) as submitted_applications,
      COUNT(*) FILTER (WHERE status IN ('DOCUMENT_COLLECTION', 'DOCUMENT_VERIFICATION', 'VERIFICATION_REQUIRED')) as verification_pending,
      COUNT(*) FILTER (WHERE status IN (
        'VERIFICATION_COMPLETED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED',
        'TEST_SCHEDULED', 'TEST_COMPLETED', 'APPLICATION_UNDER_REVIEW',
        'APPROVED', 'CONDITIONALLY_APPROVED', 'WAITLISTED', 'FEE_PENDING', 'FEE_PAID',
        'ADMISSION_CONFIRMED', 'CONVERTED_TO_STUDENT'
      )) as documents_verified_stage,
      COUNT(*) FILTER (WHERE status IN ('INTERVIEW_SCHEDULED', 'TEST_SCHEDULED')) as interviews_scheduled,
      COUNT(*) FILTER (WHERE status = 'APPLICATION_UNDER_REVIEW') as under_review,
      COUNT(*) FILTER (WHERE status IN ('APPROVED', 'CONDITIONALLY_APPROVED', 'FEE_PENDING', 'FEE_PAID')) as approved_applications,
      COUNT(*) FILTER (WHERE status = 'WAITLISTED') as waitlisted_applications,
      COUNT(*) FILTER (WHERE status = 'CONVERTED_TO_STUDENT') as converted_students,
      COUNT(*) FILTER (WHERE status = 'REJECTED') as rejected_applications,
      COUNT(*) FILTER (WHERE status = 'WITHDRAWN') as withdrawn_applications,
      COUNT(*) FILTER (WHERE is_sla_breached = true) as sla_breached_count
    FROM admission_applications
    WHERE school_id = ${schoolId}
      AND deleted_at IS NULL
      ${academicYearId ? sql`AND academic_year_id = ${academicYearId}` : sql``}
  `;

  // 2. Enquiry Counts
  const [enquiryStats] = await sql`
    SELECT
      COUNT(*) as total_enquiries,
      COUNT(*) FILTER (WHERE status = 'NEW') as new_enquiries,
      COUNT(*) FILTER (WHERE status = 'CONVERTED_TO_APPLICATION') as converted_enquiries
    FROM admission_enquiries
    WHERE school_id = ${schoolId}
      ${academicYearId ? sql`AND academic_year_id = ${academicYearId}` : sql``}
  `;

  const totalEnquiries = Number(enquiryStats?.total_enquiries || 0);
  const totalApps = Number(funnel?.total_applications || 0);
  const submittedApps = Number(funnel?.submitted_applications || 0);
  const convertedStudents = Number(funnel?.converted_students || 0);
  const approvedApps = Number(funnel?.approved_applications || 0);

  // Conversion Rates
  const enquiryToApplicationRate = totalEnquiries > 0
    ? Math.round((submittedApps / totalEnquiries) * 100)
    : (totalApps > 0 ? 100 : 0);

  const applicationToAdmissionRate = submittedApps > 0
    ? Math.round((convertedStudents / submittedApps) * 100)
    : 0;

  // 3. Source Breakdown
  const sourceRows = await sql`
    SELECT
      COALESCE(source, 'Unknown') as source,
      COUNT(*) as count,
      COUNT(*) FILTER (WHERE status = 'CONVERTED_TO_STUDENT') as converted
    FROM admission_applications
    WHERE school_id = ${schoolId}
      AND deleted_at IS NULL
      ${academicYearId ? sql`AND academic_year_id = ${academicYearId}` : sql``}
    GROUP BY source
    ORDER BY count DESC
  `;

  // 4. Class Capacity & Seat Quota Breakdown
  const classBreakdown = await sql`
    SELECT
      c.id as class_id,
      c.name as class_name,
      COALESCE(cap.total_capacity, 40) as total_capacity,
      COUNT(a.id) FILTER (WHERE a.status = 'CONVERTED_TO_STUDENT') as confirmed_students,
      COUNT(a.id) FILTER (WHERE a.status IN ('APPROVED', 'CONDITIONALLY_APPROVED', 'FEE_PENDING')) as approved_seats,
      COUNT(a.id) FILTER (WHERE a.status NOT IN ('CONVERTED_TO_STUDENT', 'REJECTED', 'WITHDRAWN')) as active_applications,
      COUNT(a.id) FILTER (WHERE a.status = 'WAITLISTED') as waitlisted_count
    FROM classes c
    LEFT JOIN admission_capacities cap ON cap.class_id = c.id AND cap.school_id = ${schoolId}
    LEFT JOIN admission_applications a ON a.applying_class_id = c.id AND a.school_id = ${schoolId} AND a.deleted_at IS NULL
    WHERE c.school_id = ${schoolId}
      AND c.deleted_at IS NULL
    GROUP BY c.id, c.name, cap.total_capacity
    ORDER BY c.name ASC
  `;

  const funnelPayload = {
      totalEnquiries,
      newEnquiries: Number(enquiryStats?.new_enquiries || 0),
      totalApplications: totalApps,
      draftApplications: Number(funnel?.draft_applications || 0),
      submittedApplications: submittedApps,
      verificationPending: Number(funnel?.verification_pending || 0),
      interviewsScheduled: Number(funnel?.interviews_scheduled || 0),
      underReview: Number(funnel?.under_review || 0),
      approvedApplications: approvedApps,
      waitlistedApplications: Number(funnel?.waitlisted_applications || 0),
      convertedStudents,
      rejectedApplications: Number(funnel?.rejected_applications || 0),
      withdrawnApplications: Number(funnel?.withdrawn_applications || 0),
      slaBreachedCount: Number(funnel?.sla_breached_count || 0),
      enquiryToApplicationRate,
      applicationToAdmissionRate,
      enquiries: totalEnquiries,
      applications: totalApps,
      verified: Number(funnel?.documents_verified_stage || 0),
      interviewed: Number(funnel?.interviews_scheduled || 0),
      approved: approvedApps,
      converted: convertedStudents,
    };

  const classCapacity = classBreakdown.map((row) => {
      const capacity = Number(row.total_capacity);
      const confirmed = Number(row.confirmed_students);
      const approved = Number(row.approved_seats);
      const committed = confirmed + approved;
      const available = Math.max(0, capacity - committed);
      return {
        classId: row.class_id,
        className: row.class_name,
        totalCapacity: capacity,
        confirmedStudents: confirmed,
        approvedSeats: approved,
        availableSeats: available,
        activeApplications: Number(row.active_applications),
        waitlistedCount: Number(row.waitlisted_count),
        utilizationPct: capacity > 0 ? Math.round((committed / capacity) * 100) : 0,
      };
    });

  const insights = [];
  if (funnelPayload.verificationPending > 0) {
    insights.push(`${funnelPayload.verificationPending} applications are waiting for document verification.`);
  }
  if (funnelPayload.slaBreachedCount > 0) {
    insights.push(`${funnelPayload.slaBreachedCount} applications have breached SLA and need immediate attention.`);
  }
  for (const cls of classCapacity) {
    if (cls.activeApplications > cls.availableSeats && cls.availableSeats <= 6) {
      insights.push(`${cls.className} has ${cls.activeApplications} active applications but only ${cls.availableSeats} available seats.`);
    }
  }
  const website = sourceRows.find((r) => /website/i.test(r.source));
  const walkin = sourceRows.find((r) => /walk/i.test(r.source));
  if (website && walkin && Number(website.count) > Number(walkin.count)) {
    insights.push('Website enquiries are currently outperforming walk-ins.');
  }

  const [turnaround] = await sql`
    SELECT AVG(EXTRACT(EPOCH FROM (converted_at - created_at)) / 86400.0) as avg_days
    FROM admission_applications
    WHERE school_id = ${schoolId} AND converted_at IS NOT NULL AND deleted_at IS NULL
      ${academicYearId ? sql`AND academic_year_id = ${academicYearId}` : sql``}
  `;

  return {
    funnel: funnelPayload,
    sources: sourceRows.map((r) => ({ source: r.source, count: Number(r.count) })),
    classCapacity,
    insights,
    conversionRate: funnelPayload.applicationToAdmissionRate,
    averageTurnaroundDays: Math.round(Number(turnaround?.avg_days || 0) * 10) / 10,
    slaCompliance: {
      complianceRate: funnelPayload.totalApplications > 0
        ? Math.round(((funnelPayload.totalApplications - funnelPayload.slaBreachedCount) / funnelPayload.totalApplications) * 100)
        : 100,
      breachedTasks: funnelPayload.slaBreachedCount,
    },
    sourceBreakdown: sourceRows.map((r) => {
      const count = Number(r.count);
      const converted = Number(r.converted || 0);
      return {
        source: r.source,
        count,
        converted,
        conversionRate: count > 0 ? Math.round((converted / count) * 100) : 0,
      };
    }),
  };
}
