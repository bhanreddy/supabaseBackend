import express from 'express';
import cors from 'cors';
import config from './config/env.js';
// Forced restart to pick up route changes
import { identifyUser } from './middleware/auth.js';
import { auditLogger } from './middleware/audit.js';
import { errorHandler } from './utils/asyncHandler.js';

const app = express();
const port = config.port;

// CORS - Allow all origins for mobile app
app.use(cors());

// Middleware
app.use(express.json());

// Auth & Audit Middleware (Global)
app.use(identifyUser);
app.use(auditLogger);

// Import routes
import authRouter from './routes/authRoutes.js';
import studentsRouter from './routes/studentsRoutes.js';
import teachersRouter from './routes/teachersRoutes.js';
import staffRouter from './routes/staffRoutes.js';
import userRoutes from './routes/userRoutes.js';
import academicsRouter from './routes/academicsRoutes.js';
import attendanceRouter from './routes/attendanceRoutes.js';
import feesRouter from './routes/feesRoutes.js';
import resultsRouter from './routes/resultsRoutes.js';
import complaintsRouter from './routes/complaintsRoutes.js';
import noticesRouter from './routes/noticesRoutes.js';
import leavesRouter from './routes/leavesRoutes.js';
import diaryRouter from './routes/diaryRoutes.js';
import timetableRouter from './routes/timetableRoutes.js';
import transportRouter from './routes/transportRoutes.js';
import hostelRouter from './routes/hostelRoutes.js';
import eventsRouter from './routes/eventsRoutes.js';
import lmsRouter from './routes/lmsRoutes.js';
import adminRouter from './routes/adminRoutes.js';
import notificationRouter from './routes/notificationRoutes.js';

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'School Management System API',
    version: '1.0.0',
    endpoints: {
      auth: '/api/v1/auth',
      admin: '/api/v1/admin',
      students: '/api/v1/students',
      staff: '/api/v1/staff',
      users: '/api/v1/users',
      academics: '/api/v1/academics',
      attendance: '/api/v1/attendance',
      fees: '/api/v1/fees',
      results: '/api/v1/results',
      complaints: '/api/v1/complaints',
      notices: '/api/v1/notices',
      leaves: '/api/v1/leaves',
      diary: '/api/v1/diary',
      timetable: '/api/v1/timetable',
      transport: '/api/v1/transport',
      hostel: '/api/v1/hostel',
      events: '/api/v1/events',
      lms: '/api/v1/lms'
    }
  });
});

// API v1 Routes
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/students', studentsRouter);
app.use('/api/v1/teachers', teachersRouter);
app.use('/api/v1/staff', staffRouter);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/academics', academicsRouter);
app.use('/api/v1/attendance', attendanceRouter);
app.use('/api/v1/fees', feesRouter);
app.use('/api/v1/results', resultsRouter);
app.use('/api/v1/complaints', complaintsRouter);
app.use('/api/v1/notices', noticesRouter);
app.use('/api/v1/leaves', leavesRouter);
app.use('/api/v1/diary', diaryRouter);
app.use('/api/v1/timetable', timetableRouter);
app.use('/api/v1/transport', transportRouter);
app.use('/api/v1/hostel', hostelRouter);
app.use('/api/v1/events', eventsRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/lms', lmsRouter);
app.use('/api/v1/notifications', notificationRouter);

// Legacy routes (for backward compatibility)
app.use('/students', studentsRouter);
app.use('/teachers', teachersRouter);
app.use('/staff', staffRouter);
app.use('/users', userRoutes);
app.use('/academics', academicsRouter);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.path });
});

// Global Error Handler
app.use(errorHandler);

app.listen(port, () => {
  console.log(`🚀 Server listening on port ${port}`);
  console.log(`📚 API Docs: http://localhost:${port}/`);
});// Restart trigger
// Restart debug
