-- ============================================================
-- Migration: Create remaining missing founder-console views
-- ============================================================

-- ── leads_by_website ─────────────────────────────────────────
CREATE OR REPLACE VIEW public.leads_by_website AS
SELECT 
  COALESCE(source, 'Unknown') AS source,
  COUNT(*) AS leads,
  COUNT(*) FILTER (WHERE status = 'CLOSED') AS deals,
  COALESCE(SUM(deal_value) FILTER (WHERE status = 'CLOSED'), 0) AS revenue
FROM public.enquiries
GROUP BY source
ORDER BY leads DESC;

-- ── founder_lead_performance ─────────────────────────────────
CREATE OR REPLACE VIEW public.founder_lead_performance AS
SELECT 
  f.full_name AS founder_name,
  COUNT(e.id) AS leads,
  COUNT(e.id) FILTER (WHERE e.status = 'CLOSED') AS deals,
  COALESCE(SUM(e.deal_value) FILTER (WHERE e.status = 'CLOSED'), 0) AS revenue
FROM public.founders f
LEFT JOIN public.enquiries e ON e.assigned_to = f.id
GROUP BY f.id, f.full_name
ORDER BY revenue DESC, deals DESC, leads DESC;
