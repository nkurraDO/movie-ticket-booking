import { randomUUID } from 'node:crypto';
import { buildShows, movies, theaters } from '../data/seed.js';
import type { Booking, Movie, Seat, SeatClass, SeatHold, Show, Theater } from '../types.js';

/** How long a checkout hold keeps seats reserved before it expires. */
const HOLD_TTL_MS = Number(process.env.SEAT_HOLD_TTL_MS ?? 5 * 60 * 1000);

/** Maximum seats a single booking may contain. */
export const MAX_SEATS_PER_BOOKING = Number(process.env.MAX_SEATS_PER_BOOKING ?? 10);

export class BookingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'BookingError';
  }
}

const ROW_LABELS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function seatClassForRow(rowIndex: number, totalRows: number): SeatClass {
  if (rowIndex >= totalRows - 1) return 'recliner';
  if (rowIndex >= Math.floor(totalRows / 2)) return 'premium';
  return 'standard';
}

const CLASS_MULTIPLIER: Record<SeatClass, number> = {
  standard: 1,
  premium: 1.4,
  recliner: 1.9,
};

/**
 * In-memory persistence layer.
 *
 * Every mutation runs synchronously, which on Node's single-threaded event loop
 * makes the read-check-write sequence in `book` atomic: two concurrent requests
 * for the same seat can never interleave, so the second one always sees the
 * first one's write and fails with SEATS_UNAVAILABLE.
 *
 * Swap this class for a database-backed implementation (with a unique index on
 * (show_id, seat_id) and a transaction) to scale past a single replica.
 */
export class Store {
  private readonly shows = new Map<string, Show>();
  private readonly bookings = new Map<string, Booking>();
  private readonly holds = new Map<string, SeatHold>();
  /** showId -> seatId -> booking reference. The source of truth for occupancy. */
  private readonly occupancy = new Map<string, Map<string, string>>();

  constructor() {
    for (const show of buildShows()) {
      this.shows.set(show.id, show);
      this.occupancy.set(show.id, new Map());
    }
  }

  // ---------------------------------------------------------------- catalogue

  listMovies(query?: { search?: string; genre?: string }): Movie[] {
    const search = query?.search?.trim().toLowerCase();
    const genre = query?.genre?.trim().toLowerCase();

    return movies.filter((movie) => {
      if (search && !movie.title.toLowerCase().includes(search)) return false;
      if (genre && !movie.genres.some((g) => g.toLowerCase() === genre)) return false;
      return true;
    });
  }

  getMovie(id: string): Movie {
    const movie = movies.find((m) => m.id === id);
    if (!movie) throw new BookingError(`Unknown movie "${id}"`, 404, 'MOVIE_NOT_FOUND');
    return movie;
  }

  getTheater(id: string): Theater {
    const theater = theaters.find((t) => t.id === id);
    if (!theater) throw new BookingError(`Unknown theater "${id}"`, 404, 'THEATER_NOT_FOUND');
    return theater;
  }

  listTheaters(): Theater[] {
    return theaters;
  }

  listShows(query?: { movieId?: string; date?: string }): Show[] {
    let result = [...this.shows.values()];
    if (query?.movieId) result = result.filter((s) => s.movieId === query.movieId);
    if (query?.date) result = result.filter((s) => s.startsAt.slice(0, 10) === query.date);
    return result.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  getShow(id: string): Show {
    const show = this.shows.get(id);
    if (!show) throw new BookingError(`Unknown show "${id}"`, 404, 'SHOW_NOT_FOUND');
    return show;
  }

  // -------------------------------------------------------------------- seats

  /** Builds the seat map for a show, applying current bookings and live holds. */
  getSeatMap(showId: string): { show: Show; movie: Movie; theater: Theater; seats: Seat[] } {
    const show = this.getShow(showId);
    const theater = this.getTheater(show.theaterId);
    const booked = this.occupancy.get(showId) ?? new Map();
    const held = this.activeHeldSeats(showId);

    const seats: Seat[] = [];
    for (let rowIndex = 0; rowIndex < theater.rows; rowIndex++) {
      const row = ROW_LABELS[rowIndex]!;
      const seatClass = seatClassForRow(rowIndex, theater.rows);
      for (let number = 1; number <= theater.seatsPerRow; number++) {
        const id = `${row}${number}`;
        seats.push({
          id,
          row,
          number,
          seatClass,
          priceCents: Math.round(show.basePriceCents * CLASS_MULTIPLIER[seatClass]),
          status: booked.has(id) ? 'booked' : held.has(id) ? 'held' : 'available',
        });
      }
    }

    return { show, movie: this.getMovie(show.movieId), theater, seats };
  }

  private activeHeldSeats(showId: string, ignoreHoldId?: string): Set<string> {
    const now = Date.now();
    const seats = new Set<string>();
    for (const hold of this.holds.values()) {
      if (hold.showId !== showId || hold.id === ignoreHoldId) continue;
      if (hold.expiresAt <= now) {
        this.holds.delete(hold.id);
        continue;
      }
      for (const seatId of hold.seatIds) seats.add(seatId);
    }
    return seats;
  }

  /** Reserves seats for a few minutes so a customer can complete checkout. */
  hold(showId: string, seatIds: string[]): SeatHold {
    const { seats } = this.getSeatMap(showId);
    this.assertSeatsSelectable(seatIds, seats);

    const hold: SeatHold = {
      id: `hold_${randomUUID()}`,
      showId,
      seatIds: [...seatIds],
      expiresAt: Date.now() + HOLD_TTL_MS,
    };
    this.holds.set(hold.id, hold);
    return hold;
  }

  releaseHold(holdId: string): void {
    this.holds.delete(holdId);
  }

  private assertSeatsSelectable(seatIds: string[], seats: Seat[]): Seat[] {
    if (seatIds.length === 0) {
      throw new BookingError('Select at least one seat', 400, 'NO_SEATS_SELECTED');
    }
    if (seatIds.length > MAX_SEATS_PER_BOOKING) {
      throw new BookingError(
        `A single booking is limited to ${MAX_SEATS_PER_BOOKING} seats`,
        400,
        'TOO_MANY_SEATS',
      );
    }
    if (new Set(seatIds).size !== seatIds.length) {
      throw new BookingError('Duplicate seats in selection', 400, 'DUPLICATE_SEATS');
    }

    const byId = new Map(seats.map((s) => [s.id, s]));
    const unknown = seatIds.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw new BookingError(
        `Seats do not exist in this auditorium: ${unknown.join(', ')}`,
        400,
        'SEAT_NOT_FOUND',
        { seats: unknown },
      );
    }

    const taken = seatIds.filter((id) => byId.get(id)!.status !== 'available');
    if (taken.length > 0) {
      throw new BookingError(
        `Seats are no longer available: ${taken.join(', ')}`,
        409,
        'SEATS_UNAVAILABLE',
        { seats: taken },
      );
    }

    return seatIds.map((id) => byId.get(id)!);
  }

  // ----------------------------------------------------------------- bookings

  book(input: {
    showId: string;
    seatIds: string[];
    customerName: string;
    email: string;
    holdId?: string;
  }): Booking {
    const show = this.getShow(input.showId);

    if (new Date(show.startsAt).getTime() <= Date.now()) {
      throw new BookingError('This show has already started', 409, 'SHOW_STARTED');
    }

    // Seats inside the caller's own hold must not count as unavailable.
    const { seats } = this.getSeatMap(input.showId);
    const ownHeld = input.holdId
      ? new Set(this.holds.get(input.holdId)?.seatIds ?? [])
      : new Set<string>();
    const visible = seats.map((seat) =>
      seat.status === 'held' && ownHeld.has(seat.id) ? { ...seat, status: 'available' as const } : seat,
    );

    const selected = this.assertSeatsSelectable(input.seatIds, visible);

    const booking: Booking = {
      reference: generateReference(),
      showId: input.showId,
      seatIds: [...input.seatIds],
      customerName: input.customerName,
      email: input.email,
      totalCents: selected.reduce((sum, seat) => sum + seat.priceCents, 0),
      currency: show.currency,
      status: 'confirmed',
      createdAt: new Date().toISOString(),
    };

    const occupied = this.occupancy.get(input.showId)!;
    for (const seatId of input.seatIds) occupied.set(seatId, booking.reference);
    this.bookings.set(booking.reference, booking);
    if (input.holdId) this.releaseHold(input.holdId);

    return booking;
  }

  getBooking(reference: string): Booking {
    const booking = this.bookings.get(reference.toUpperCase());
    if (!booking) throw new BookingError(`Unknown booking "${reference}"`, 404, 'BOOKING_NOT_FOUND');
    return booking;
  }

  listBookings(email?: string): Booking[] {
    const all = [...this.bookings.values()];
    const filtered = email
      ? all.filter((b) => b.email.toLowerCase() === email.toLowerCase())
      : all;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  cancelBooking(reference: string): Booking {
    const booking = this.getBooking(reference);
    if (booking.status === 'cancelled') return booking;

    const show = this.getShow(booking.showId);
    if (new Date(show.startsAt).getTime() <= Date.now()) {
      throw new BookingError('Cannot cancel a show that has started', 409, 'SHOW_STARTED');
    }

    const occupied = this.occupancy.get(booking.showId)!;
    for (const seatId of booking.seatIds) {
      if (occupied.get(seatId) === booking.reference) occupied.delete(seatId);
    }

    const cancelled: Booking = { ...booking, status: 'cancelled' };
    this.bookings.set(cancelled.reference, cancelled);
    return cancelled;
  }

  /** Lightweight counters surfaced on /api/stats and useful for dashboards. */
  stats() {
    const bookings = [...this.bookings.values()];
    const confirmed = bookings.filter((b) => b.status === 'confirmed');
    return {
      movies: movies.length,
      theaters: theaters.length,
      shows: this.shows.size,
      bookings: bookings.length,
      confirmedBookings: confirmed.length,
      seatsSold: confirmed.reduce((sum, b) => sum + b.seatIds.length, 0),
      revenueCents: confirmed.reduce((sum, b) => sum + b.totalCents, 0),
      activeHolds: this.holds.size,
    };
  }
}

/** Human-friendly booking reference, e.g. "MTB-7QK4ZP". */
function generateReference(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `MTB-${suffix}`;
}

export const store = new Store();
