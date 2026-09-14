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
  /** Seat map geometry. Rows are lettered A.. and seats numbered 1..seatsPerRow. */
  rows: number;
  seatsPerRow: number;
}

export interface Show {
  id: string;
  movieId: string;
  theaterId: string;
  screen: string;
  /** ISO-8601 start time. */
  startsAt: string;
  /** Price in minor units (cents) for a standard seat. */
  basePriceCents: number;
  currency: string;
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

/** A short-lived reservation that blocks seats while a customer checks out. */
export interface SeatHold {
  id: string;
  showId: string;
  seatIds: string[];
  expiresAt: number;
}
