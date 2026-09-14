export interface Movie {
  id: string;
  title: string;
  synopsis: string;
  genres: string[];
  rating: string;
  runtimeMinutes: number;
  language: string;
  posterColor: string;
}

export interface Theater {
  id: string;
  name: string;
  city: string;
  rows: number;
  seatsPerRow: number;
}

export interface Show {
  id: string;
  movieId: string;
  theaterId: string;
  screen: string;
  startsAt: string;
  basePriceCents: number;
  currency: string;
  movie?: Movie;
  theater?: Theater;
}

export type SeatClass = 'standard' | 'premium' | 'recliner';

export interface Seat {
  id: string;
  row: string;
  number: number;
  seatClass: SeatClass;
  priceCents: number;
  status: 'available' | 'held' | 'booked';
}

export interface Booking {
  reference: string;
  showId: string;
  seatIds: string[];
  customerName: string;
  email: string;
  totalCents: number;
  currency: string;
  status: 'confirmed' | 'cancelled';
  createdAt: string;
}

export interface SeatMapResponse {
  show: Show;
  movie: Movie;
  theater: Theater;
  seats: Seat[];
  maxSeatsPerBooking: number;
  available: number;
}

/** Same-origin by default: nginx (prod) and Vite (dev) both proxy /api. */
const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError('Cannot reach the booking service. Is the backend running?', 0, 'NETWORK');
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload as { error?: { message?: string; code?: string } } | null)?.error;
    throw new ApiError(
      error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      error?.code ?? 'UNKNOWN',
    );
  }
  return payload as T;
}

export const api = {
  listMovies: (search?: string) =>
    request<{ movies: Movie[] }>(`/api/movies${search ? `?search=${encodeURIComponent(search)}` : ''}`),

  getMovie: (id: string) => request<{ movie: Movie; shows: Show[] }>(`/api/movies/${id}`),

  getSeatMap: (showId: string) => request<SeatMapResponse>(`/api/shows/${showId}/seats`),

  createBooking: (body: {
    showId: string;
    seatIds: string[];
    customerName: string;
    email: string;
  }) =>
    request<{ booking: Booking }>('/api/bookings', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getBooking: (reference: string) =>
    request<{ booking: Booking; show: Show; movie: Movie; theater: Theater }>(
      `/api/bookings/${reference}`,
    ),

  listBookings: (email: string) =>
    request<{ bookings: Booking[] }>(`/api/bookings?email=${encodeURIComponent(email)}`),

  cancelBooking: (reference: string) =>
    request<{ booking: Booking }>(`/api/bookings/${reference}`, { method: 'DELETE' }),
};

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export function formatShowtime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}
