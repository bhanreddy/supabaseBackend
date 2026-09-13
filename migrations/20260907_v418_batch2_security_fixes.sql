-- Forward-only Batch 2 security/concurrency corrections from the Phase 5-12 audit.
REVOKE ALL ON TABLE public.attendance_interventions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.transport_safety_incidents FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ticket_number_counters FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.support_tickets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.support_ticket_messages FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.attendance_interventions TO service_role;
GRANT ALL ON TABLE public.transport_safety_incidents TO service_role;
GRANT ALL ON TABLE public.ticket_number_counters TO service_role;
GRANT ALL ON TABLE public.support_tickets TO service_role;
GRANT ALL ON TABLE public.support_ticket_messages TO service_role;

REVOKE EXECUTE ON FUNCTION public.get_next_ticket_number(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_next_ticket_number(integer) TO service_role;

-- Recommendations are not assignments.
ALTER TABLE public.timetable_substitutions
  ALTER COLUMN substitute_teacher_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS suggested_teacher_id uuid REFERENCES public.staff(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_transport_active_vehicle_incident
  ON public.transport_safety_incidents (school_id, vehicle_id, incident_type)
  WHERE vehicle_id IS NOT NULL
    AND incident_type IN ('overspeed', 'sos')
    AND status IN ('active', 'acknowledged');
CREATE UNIQUE INDEX IF NOT EXISTS uq_transport_active_safeguarding_incident
  ON public.transport_safety_incidents (school_id, student_id, incident_type)
  WHERE student_id IS NOT NULL
    AND incident_type = 'safeguarding_anomaly'
    AND status IN ('active', 'verification_pending', 'acknowledged');
