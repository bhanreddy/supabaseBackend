-- SchoolIMS Smart Popup Manager
-- Tenant-scoped in-app popups with lazy per-user state. API routes use JWT school_id;
-- RLS is defense in depth. Do not pre-create user state rows at publish time.

BEGIN;

CREATE TABLE IF NOT EXISTS public.popups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  title VARCHAR(120) NOT NULL,
  heading VARCHAR(180),
  message TEXT NOT NULL,
  category VARCHAR(32) NOT NULL DEFAULT 'INFORMATION',
  priority VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
  layout_type VARCHAR(24) NOT NULL DEFAULT 'STANDARD',
  image_url TEXT,
  storage_path TEXT,
  icon VARCHAR(48),
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  frequency VARCHAR(32) NOT NULL DEFAULT 'SHOW_ONCE',
  start_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_at TIMESTAMPTZ,
  allow_dismiss BOOLEAN NOT NULL DEFAULT TRUE,
  require_acknowledgement BOOLEAN NOT NULL DEFAULT FALSE,
  send_push BOOLEAN NOT NULL DEFAULT FALSE,
  update_mode VARCHAR(24) NOT NULL DEFAULT 'NONE',
  targeting JSONB NOT NULL DEFAULT '{}'::jsonb,
  buttons JSONB NOT NULL DEFAULT '[]'::jsonb,
  completion_condition JSONB NOT NULL DEFAULT '{"type":"NONE"}'::jsonb,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ,
  published_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT chk_popups_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT chk_popups_message_not_blank CHECK (length(btrim(message)) > 0),
  CONSTRAINT chk_popups_category CHECK (category IN (
    'INFORMATION','WARNING','IMPORTANT','EMERGENCY','FEATURE_UPDATE','APP_UPDATE',
    'PAYMENT','ATTENDANCE','EXAM','TRANSPORT','DOCUMENT','MAINTENANCE','CUSTOM'
  )),
  CONSTRAINT chk_popups_priority CHECK (priority IN ('LOW','NORMAL','HIGH','CRITICAL')),
  CONSTRAINT chk_popups_layout CHECK (layout_type IN ('COMPACT','STANDARD','RICH','CRITICAL','UPDATE')),
  CONSTRAINT chk_popups_status CHECK (status IN ('DRAFT','SCHEDULED','ACTIVE','PAUSED','EXPIRED','ARCHIVED')),
  CONSTRAINT chk_popups_frequency CHECK (frequency IN (
    'SHOW_ONCE','UNTIL_ACKNOWLEDGED','EVERY_LOGIN','ONCE_PER_DAY','UNTIL_ACTION_COMPLETED'
  )),
  CONSTRAINT chk_popups_update_mode CHECK (update_mode IN ('NONE','OPTIONAL_UPDATE','FORCED_UPDATE')),
  CONSTRAINT chk_popups_end_after_start CHECK (end_at IS NULL OR end_at > start_at)
);

CREATE INDEX IF NOT EXISTS idx_popups_school_status_schedule
  ON public.popups (school_id, status, start_at, end_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_popups_school_created
  ON public.popups (school_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_popups_school_category
  ON public.popups (school_id, category)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.popup_user_states (
  school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  popup_id UUID NOT NULL REFERENCES public.popups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  last_displayed_at TIMESTAMPTZ,
  last_session_id VARCHAR(64),
  view_count INTEGER NOT NULL DEFAULT 0,
  clicked_at TIMESTAMPTZ,
  click_count INTEGER NOT NULL DEFAULT 0,
  last_action_type VARCHAR(40),
  acknowledged_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  inbox_read_at TIMESTAMPTZ,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  test_queued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (school_id, popup_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_popup_user_states_user
  ON public.popup_user_states (school_id, user_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_popup_user_states_popup
  ON public.popup_user_states (school_id, popup_id)
  WHERE is_test = FALSE;

CREATE INDEX IF NOT EXISTS idx_popup_user_states_unread
  ON public.popup_user_states (school_id, user_id)
  WHERE inbox_read_at IS NULL AND is_test = FALSE;

CREATE TABLE IF NOT EXISTS public.popup_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  popup_id UUID NOT NULL REFERENCES public.popups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event_type VARCHAR(32) NOT NULL,
  action_type VARCHAR(40),
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_popup_events_type CHECK (event_type IN (
    'POPUP_ELIGIBLE','POPUP_VIEWED','POPUP_CLICKED','POPUP_DISMISSED',
    'POPUP_ACKNOWLEDGED','POPUP_ACTION_COMPLETED'
  ))
);

CREATE INDEX IF NOT EXISTS idx_popup_events_popup_created
  ON public.popup_events (school_id, popup_id, created_at DESC)
  WHERE is_test = FALSE;

CREATE INDEX IF NOT EXISTS idx_popup_events_user
  ON public.popup_events (school_id, user_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_popups_updated ON public.popups;
CREATE TRIGGER trg_popups_updated
BEFORE UPDATE ON public.popups
FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

DROP TRIGGER IF EXISTS trg_popup_user_states_updated ON public.popup_user_states;
CREATE TRIGGER trg_popup_user_states_updated
BEFORE UPDATE ON public.popup_user_states
FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

ALTER TABLE public.popups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.popups FORCE ROW LEVEL SECURITY;
ALTER TABLE public.popup_user_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.popup_user_states FORCE ROW LEVEL SECURITY;
ALTER TABLE public.popup_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.popup_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS popups_tenant_select ON public.popups;
CREATE POLICY popups_tenant_select
  ON public.popups
  FOR SELECT
  TO authenticated
  USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR school_id = public.auth_school_id()
  );

DROP POLICY IF EXISTS popups_admin_manage ON public.popups;
CREATE POLICY popups_admin_manage
  ON public.popups
  FOR ALL
  TO authenticated
  USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
      school_id = public.auth_school_id()
      AND public.auth_has_role(ARRAY['admin', 'principal'])
    )
  )
  WITH CHECK (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
      school_id = public.auth_school_id()
      AND public.auth_has_role(ARRAY['admin', 'principal'])
    )
  );

DROP POLICY IF EXISTS popup_user_states_self ON public.popup_user_states;
CREATE POLICY popup_user_states_self
  ON public.popup_user_states
  FOR ALL
  TO authenticated
  USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
      school_id = public.auth_school_id()
      AND (
        user_id = auth.uid()
        OR public.auth_has_role(ARRAY['admin', 'principal'])
      )
    )
  )
  WITH CHECK (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
      school_id = public.auth_school_id()
      AND (
        user_id = auth.uid()
        OR public.auth_has_role(ARRAY['admin', 'principal'])
      )
    )
  );

DROP POLICY IF EXISTS popup_events_self ON public.popup_events;
CREATE POLICY popup_events_self
  ON public.popup_events
  FOR SELECT
  TO authenticated
  USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
      school_id = public.auth_school_id()
      AND (
        user_id = auth.uid()
        OR public.auth_has_role(ARRAY['admin', 'principal'])
      )
    )
  );

DROP POLICY IF EXISTS popup_events_insert_self ON public.popup_events;
CREATE POLICY popup_events_insert_self
  ON public.popup_events
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
      school_id = public.auth_school_id()
      AND user_id = auth.uid()
    )
  );

INSERT INTO permissions (school_id, code, name)
SELECT s.id, v.code, v.name
FROM schools s
CROSS JOIN (VALUES
    ('popups.view', 'View in-app popups and updates'),
    ('popups.create', 'Create in-app popups'),
    ('popups.update', 'Update in-app popups'),
    ('popups.delete', 'Delete or archive in-app popups'),
    ('popups.publish', 'Publish, pause, or resume in-app popups'),
    ('popups.analytics', 'View popup analytics')
) AS v(code, name)
ON CONFLICT (school_id, code) DO UPDATE
SET name = EXCLUDED.name, deleted_at = NULL;

INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM permissions p
JOIN roles r
  ON r.school_id = p.school_id
 AND r.deleted_at IS NULL
WHERE p.code = 'popups.view'
  AND p.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) DO UPDATE
SET school_id = EXCLUDED.school_id, deleted_at = NULL;

INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM permissions p
JOIN roles r
  ON r.school_id = p.school_id
 AND r.code IN ('admin', 'principal')
 AND r.deleted_at IS NULL
WHERE p.code IN ('popups.create', 'popups.update', 'popups.delete', 'popups.publish', 'popups.analytics')
  AND p.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) DO UPDATE
SET school_id = EXCLUDED.school_id, deleted_at = NULL;

COMMIT;
