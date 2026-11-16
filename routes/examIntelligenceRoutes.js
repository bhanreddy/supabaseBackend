import express from 'express';
import rateLimit from 'express-rate-limit';
import sql from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import * as service from '../services/examIntelligenceService.js';
export function createExamIntelligenceRouter(db = sql) {
  const router = express.Router();
  const track = fn => asyncHandler(async (req, res, next) => {
    req.examIntelligenceRunning = true;
    try {
      return await fn(req, res, next);
    } finally {
      req.examIntelligenceRunning = false;
      req.releaseExamIntelligence?.();
    }
  });
  const inFlight = new Map();
  router.use(requireAuth, requirePermission('admin.manage'));
  router.use((req, res, next) => {
    const trusted = req.activeContext?.school_id || req.user?.schoolId;
    if (!trusted || !Number.isInteger(Number(trusted)) || Number(trusted) <= 0) return res.status(403).json({
      error: 'School context required'
    });
    req.schoolId = String(trusted);
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  router.use(rateLimit({
    windowMs: 60000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: req => `${req.schoolId}:${req.user.internal_id || req.user.id}`,
    message: {
      error: 'Too many analytics requests. Please retry shortly.'
    }
  }));
  router.use((req, res, next) => {
    const key = req.schoolId,
      count = inFlight.get(key) || 0;
    if (count >= 4) return res.status(429).json({
      error: 'This school has four analytics requests running. Please retry shortly.'
    });
    inFlight.set(key, count + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const remaining = (inFlight.get(key) || 1) - 1;
      if (remaining) inFlight.set(key, remaining);else inFlight.delete(key);
    };
    req.releaseExamIntelligence = release;
    res.once('finish', release);
    res.once('close', () => {
      if (!req.examIntelligenceRunning) release();
    });
    next();
  });
  const user = req => req.staffPortalAccess?.admin_user_id || req.user.internal_id || req.user.id;
  const enabled = async (req, tx) => {
    if (!(await service.capabilities(req.schoolId, tx)).enabled) throw service.failure('Exam Intelligence pilot is disabled for this school', 409);
  };
  const audit = async (req, action) => db`INSERT INTO audit_logs(school_id,user_id,action,entity,entity_id,details) VALUES(${req.schoolId},${user(req)},${action},'exam_intelligence',${req.query.exam_id || req.params.id || null},${db.json({
    calculation_version: 'exam-intelligence/1.0.0',
    request_id: req.requestId || null
  })})`;
  const read = (path, fn) => router.get(path, track(async (req, res) => {
    const data = await service.readSnapshot(async tx => {
      await enabled(req, tx);
      return fn(req, tx);
    }, db);
    await audit(req, `READ exam_intelligence${path}`);
    return sendSuccess(res, req.schoolId, data);
  }));
  router.get('/capabilities', track(async (req, res) => sendSuccess(res, req.schoolId, await service.capabilities(req.schoolId, db))));
  router.put('/configuration', track(async (req, res) => {
    const data = await db.begin(tx => service.configure(req.schoolId, req.body, tx));
    await audit(req, 'CONFIGURE exam_intelligence');
    return sendSuccess(res, req.schoolId, data);
  }));
  read('/search', (req, tx) => service.analyticalSearch(req.schoolId, req.query, tx));
  read('/trends', (req, tx) => service.trendHistory(req.schoolId, service.validateFilters(req.query), tx));
  read('/student-comparison', (req, tx) => service.compareStudents(req.schoolId, service.validateFilters(req.query), req.query.peer_id, tx));
  read('/context', (req, tx) => service.context(req.schoolId, req.query, tx));
  read('/summary', async (req, tx) => service.publicReport(await service.report(req.schoolId, service.validateFilters(req.query), tx)));
  read('/students', async (req, tx) => service.studentRows(await service.report(req.schoolId, service.validateFilters(req.query), tx), req.query));
  read('/student', (req, tx) => service.studentProfile(req.schoolId, service.validateFilters(req.query), tx));
  read('/views', (req, tx) => service.listViews(req.schoolId, user(req), tx));
  router.post('/views', track(async (req, res) => {
    const data = await db.begin(async tx => {
      await enabled(req, tx);
      return service.saveView(req.schoolId, user(req), req.body, tx);
    });
    return sendSuccess(res, req.schoolId, data, 201);
  }));
  router.delete('/views/:id', track(async (req, res) => {
    if (!service.UUID.test(req.params.id)) throw service.failure('Invalid view id');
    const deleted = await db.begin(async tx => {
      await enabled(req, tx);
      return tx`DELETE FROM exam_intelligence_saved_views WHERE id=${req.params.id} AND school_id=${req.schoolId} AND user_id=${user(req)} RETURNING id`;
    });
    if (!deleted.length) throw service.failure('Saved view not found', 404);
    return sendSuccess(res, req.schoolId, {
      deleted: true
    });
  }));
  read('/actions', (req, tx) => service.listActions(req.schoolId, req.query, tx));
  router.post('/actions', track(async (req, res) => {
    const data = await db.begin('isolation level repeatable read', async tx => {
      await enabled(req, tx);
      return service.createActions(req.schoolId, user(req), req.body, tx);
    });
    return sendSuccess(res, req.schoolId, data, 201);
  }));
  router.patch('/actions/:id', track(async (req, res) => {
    const data = await db.begin('isolation level repeatable read', async tx => {
      await enabled(req, tx);
      return service.updateAction(req.schoolId, user(req), req.params.id, req.body, tx);
    });
    return sendSuccess(res, req.schoolId, data);
  }));
  read('/export', async (req, tx) => {
    if (req.query.format && !['csv', 'xlsx'].includes(req.query.format)) throw service.failure('Unsupported export format');
    const {
      tabular_rows,
      ...data
    } = service.exportReport(await service.report(req.schoolId, service.validateFilters(req.query), tx), {
      include_students: req.query.include_students === 'true'
    });
    if (req.query.format === 'xlsx') {
      const imported = await import('xlsx'),
        XLSX = imported.default || imported;
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(tabular_rows), 'Exam evidence');
      return {
        filename: data.filename.replace(/\.csv$/, '.xlsx'),
        content_base64: XLSX.write(workbook, {
          type: 'base64',
          bookType: 'xlsx'
        }),
        mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      };
    }
    if (req.query.student_id) data.student = await service.studentProfile(req.schoolId, service.validateFilters(req.query), tx);
    data.actions = await service.listActions(req.schoolId, service.validateFilters(req.query), tx);
    return data;
  });
  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || 500;
    if (status === 500) console.error('[exam-intelligence]', {
      code: err.code,
      requestId: req.requestId
    });
    return res.status(status).json({
      error: status === 500 ? 'Exam analytics temporarily unavailable. Please retry.' : err.message
    });
  });
  return router;
}
export default createExamIntelligenceRouter();
