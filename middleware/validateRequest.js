import { z } from 'zod';

/**
 * Zod edge validator. Zod objects strip unknown keys by default; that is
 * deliberate here so client-supplied school_id and future surprise fields can
 * never reach a transport service accidentally.
 */
export const validateRequest = ({ body, query, params }) => (req, res, next) => {
  const parse = (schema, value, target) => {
    if (!schema) return true;
    const result = schema.safeParse(value || {});
    if (!result.success) {
      res.status(400).json({ error: 'Invalid request', details: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
      return false;
    }
    req[target] = result.data;
    return true;
  };
  if (!parse(params, req.params, 'params')) return;
  if (!parse(query, req.query, 'query')) return;
  if (!parse(body, req.body, 'body')) return;
  next();
};

export const transportSchemas = Object.freeze({
  busParams: z.object({ id: z.uuid() }),
  routeParams: z.object({ routeId: z.uuid() }),
  stopParams: z.object({ stopId: z.uuid() }),
  location: z.object({
    latitude: z.coerce.number().gte(-90).lte(90),
    longitude: z.coerce.number().gte(-180).lte(180),
    speed: z.coerce.number().gte(0).lte(250).optional(),
    heading: z.coerce.number().gte(0).lt(360).optional(),
    is_mocked: z.boolean().optional().default(false),
  }),
  locationBatch: z.object({
    fixes: z.array(z.object({
      latitude: z.coerce.number().gte(-90).lte(90),
      longitude: z.coerce.number().gte(-180).lte(180),
      speed: z.coerce.number().gte(0).lte(250).optional(),
      heading: z.coerce.number().gte(0).lt(360).optional(),
      recorded_at: z.string().datetime({ offset: true }),
      is_mocked: z.boolean().optional().default(false),
    })).min(1).max(1000),
  }),
  calibrationLeg: z.object({ trip_direction: z.enum(['morning', 'evening', 'afternoon']) }),
  emptyBody: z.object({}),
  geoOverride: z.object({
    trip_direction: z.enum(['morning', 'evening', 'afternoon']),
    latitude: z.coerce.number().gte(-90).lte(90).optional(),
    longitude: z.coerce.number().gte(-180).lte(180).optional(),
    locked: z.boolean().optional(),
  }).refine((body) => body.latitude !== undefined || body.longitude !== undefined || body.locked !== undefined, {
    message: 'Provide latitude, longitude, or locked',
  }),
});
