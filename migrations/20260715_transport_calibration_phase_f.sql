-- Phase F: admin-reviewed calibration coordinates can be locked against
-- automatic centroid/radius refinement. Forward-only and additive.

ALTER TABLE route_stop_geo
  ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT false;

