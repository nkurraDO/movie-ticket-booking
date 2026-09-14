import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { api } from './routes/api.js';
import { BookingError } from './lib/store.js';

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';
const SERVICE_NAME = process.env.SERVICE_NAME ?? 'mtb-backend';
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? '*';
/** Grace period that lets in-flight requests finish before the process exits. */
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000);

const app = express();
const startedAt = Date.now();

/** Flipped to false on SIGTERM so the readiness probe drains this pod first. */
let ready = true;

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(helmet());
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',') }));
app.use(express.json({ limit: '64kb' }));
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.LOG_FORMAT ?? 'combined'));
}

// Identifies which pod served a request; invaluable when debugging a Deployment.
app.use((_req, res, next) => {
  res.setHeader('X-Served-By', process.env.HOSTNAME ?? SERVICE_NAME);
  next();
});

// Liveness: the process is up. Kubernetes restarts the container if this fails.
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE_NAME, uptimeSeconds: (Date.now() - startedAt) / 1000 });
});

// Readiness: this pod should receive traffic.
app.get('/readyz', (_req, res) => {
  if (!ready) {
    res.status(503).json({ status: 'shutting-down', service: SERVICE_NAME });
    return;
  }
  res.json({ status: 'ready', service: SERVICE_NAME });
});

app.get('/', (_req, res) => {
  res.json({
    service: SERVICE_NAME,
    version: process.env.APP_VERSION ?? '1.0.0',
    endpoints: ['/api/movies', '/api/shows', '/api/shows/:id/seats', '/api/bookings', '/api/stats'],
  });
});

app.use('/api', api);

app.use((_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof BookingError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[${SERVICE_NAME}] listening on http://${HOST}:${PORT}`);
});

/**
 * Kubernetes sends SIGTERM, then removes the pod from Service endpoints.
 * Failing readiness first and pausing briefly avoids dropping requests that
 * were routed to this pod while the endpoint update propagates.
 */
function shutdown(signal: string) {
  console.log(`[${SERVICE_NAME}] ${signal} received, draining connections`);
  ready = false;

  setTimeout(() => {
    server.close((err) => {
      if (err) {
        console.error('[shutdown] error closing server', err);
        process.exit(1);
      }
      console.log(`[${SERVICE_NAME}] shutdown complete`);
      process.exit(0);
    });
  }, 3_000).unref();

  setTimeout(() => {
    console.error('[shutdown] forced exit after timeout');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
