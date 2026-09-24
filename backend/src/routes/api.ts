import { Router } from 'express';
import { z } from 'zod';
import { BookingError, MAX_SEATS_PER_BOOKING, store } from '../lib/store.js';

export const api = Router();

/**
 * Wraps a handler so thrown errors reach the Express error middleware.
 * Express 4 does not forward rejected promises, so async handlers have their
 * rejection routed to `next` explicitly.
 */
function handle(fn: (req: any, res: any) => void | Promise<void>) {
  return (req: any, res: any, next: any) => {
    try {
      const result = fn(req, res);
      if (result instanceof Promise) result.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BookingError('Request validation failed', 400, 'VALIDATION_ERROR', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

// ------------------------------------------------------------------ catalogue

api.get(
  '/movies',
  handle((req, res) => {
    const query = parse(
      z.object({ search: z.string().optional(), genre: z.string().optional() }),
      req.query,
    );
    res.json({ movies: store.listMovies(query) });
  }),
);

api.get(
  '/movies/:id',
  handle((req, res) => {
    const movie = store.getMovie(req.params.id);
    const shows = store.listShows({ movieId: movie.id }).map((show) => ({
      ...show,
      theater: store.getTheater(show.theaterId),
    }));
    res.json({ movie, shows });
  }),
);

api.get(
  '/theaters',
  handle((_req, res) => {
    res.json({ theaters: store.listTheaters() });
  }),
);

api.get(
  '/shows',
  handle((req, res) => {
    const query = parse(
      z.object({
        movieId: z.string().optional(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
          .optional(),
      }),
      req.query,
    );
    const shows = store.listShows(query).map((show) => ({
      ...show,
      movie: store.getMovie(show.movieId),
      theater: store.getTheater(show.theaterId),
    }));
    res.json({ shows });
  }),
);

// Auditorium format shown on the seat map, e.g. "Dolby Atmos" rather than the
// raw config key. Kept here rather than in the theater seed data because it
// is a per-show projection setting, not a fixed property of the room.
const SCREEN_FORMAT_LABELS: Record<string, string> = {
  STANDARD: 'Standard',
  IMAX: 'IMAX',
  DOLBY: 'Dolby Atmos',
};
const DEFAULT_SCREEN_FORMAT = process.env.DEFAULT_SCREEN_FORMAT ?? 'STANDARD';

api.get(
  '/shows/:id/seats',
  handle((req, res) => {
    const { show, movie, theater, seats } = store.getSeatMap(req.params.id);
    res.json({
      show,
      movie,
      theater,
      seats,
      screenFormat: SCREEN_FORMAT_LABELS[DEFAULT_SCREEN_FORMAT].toUpperCase(),
      maxSeatsPerBooking: MAX_SEATS_PER_BOOKING,
      available: seats.filter((s) => s.status === 'available').length,
    });
  }),
);

// ---------------------------------------------------------------------- holds

const seatSelection = z.object({
  showId: z.string().min(1),
  seatIds: z.array(z.string().min(1)).min(1).max(MAX_SEATS_PER_BOOKING),
});

api.post(
  '/holds',
  handle((req, res) => {
    const body = parse(seatSelection, req.body);
    const hold = store.hold(body.showId, body.seatIds);
    res.status(201).json({ hold });
  }),
);

api.delete(
  '/holds/:id',
  handle((req, res) => {
    store.releaseHold(req.params.id);
    res.status(204).end();
  }),
);

// ------------------------------------------------------------------- bookings

api.post(
  '/bookings',
  handle(async (req, res) => {
    const body = parse(
      seatSelection.extend({
        customerName: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
        email: z.string().trim().email('A valid email is required'),
        holdId: z.string().optional(),
      }),
      req.body,
    );
    const booking = await store.book(body);
    res.status(201).json({ booking });
  }),
);

api.get(
  '/bookings',
  handle((req, res) => {
    const query = parse(z.object({ email: z.string().email().optional() }), req.query);
    res.json({ bookings: store.listBookings(query.email) });
  }),
);

api.get(
  '/bookings/:reference',
  handle((req, res) => {
    const booking = store.getBooking(req.params.reference);
    const show = store.getShow(booking.showId);
    res.json({
      booking,
      show,
      movie: store.getMovie(show.movieId),
      theater: store.getTheater(show.theaterId),
    });
  }),
);

api.delete(
  '/bookings/:reference',
  handle((req, res) => {
    res.json({ booking: store.cancelBooking(req.params.reference) });
  }),
);

api.get(
  '/stats',
  handle((_req, res) => {
    res.json(store.stats());
  }),
);
