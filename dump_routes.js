import express from 'express';
import authRouter from './routes/authRoutes.js';
import studentsRouter from './routes/studentsRoutes.js';
import academicsRouter from './routes/academicsRoutes.js';
// ... other imports if needed, but let's just focus on these

const app = express();
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/students', studentsRouter);
app.use('/api/v1/academics', academicsRouter);

function print(path, layer) {
    if (layer.route) {
        layer.route.stack.forEach(print.bind(null, path + (layer.route.path || '')));
    } else if (layer.name === 'router' && layer.handle.stack) {
        layer.handle.stack.forEach(print.bind(null, path + (layer.regexp.source.replace('\\/?', '').replace('(?=\\/|$)', '').replace('^', ''))));
    } else if (layer.method) {
        console.log('%s /api/v1%s', layer.method.toUpperCase(), path);
    }
}

console.log('Registered Routes:');
app._router.stack.forEach(print.bind(null, ''));
process.exit(0);
