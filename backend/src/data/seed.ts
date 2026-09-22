import type { Movie, Show, Theater } from '../types.js';

export const movies: Movie[] = [
  {
    id: 'mov-interstellar',
    title: 'Interstellar',
    synopsis:
      'A team of explorers travel through a wormhole in space in an attempt to ensure humanity survives.',
    genres: ['Sci-Fi', 'Drama'],
    rating: 'PG-13',
    runtimeMinutes: 169,
    language: 'English',
    posterColor: '#1e3a8a',
  },
  {
    id: 'mov-dune-two',
    title: 'Dune: Part Two',
    synopsis:
      'Paul Atreides unites with the Fremen to wage war against the conspirators who destroyed his family.',
    genres: ['Sci-Fi', 'Adventure'],
    rating: 'PG-13',
    runtimeMinutes: 166,
    language: 'English',
    posterColor: '#b45309',
  },
  {
    id: 'mov-spirited-away',
    title: 'Spirited Away',
    synopsis:
      'A young girl wanders into a world of spirits and must work to free herself and her parents.',
    genres: ['Animation', 'Fantasy'],
    rating: 'PG',
    runtimeMinutes: 125,
    language: 'Japanese',
    posterColor: '#047857',
  },
  {
    id: 'mov-the-batman',
    title: 'The Batman',
    synopsis:
      'Batman uncovers corruption in Gotham City while pursuing a sadistic killer who leaves cryptic clues.',
    genres: ['Action', 'Crime'],
    rating: 'PG-13',
    runtimeMinutes: 176,
    language: 'English',
    posterColor: '#3f3f46',
  },
  {
    id: 'mov-rrr',
    title: 'RRR',
    synopsis:
      'Two revolutionaries and their fight against the British Raj in 1920s India.',
    genres: ['Action', 'Drama'],
    rating: 'PG-13',
    runtimeMinutes: 187,
    language: 'Telugu',
    posterColor: '#9f1239',
  },
  {
    id: 'mov-past-lives',
    title: 'Past Lives',
    synopsis:
      'Two childhood friends reunite decades later for one fateful week that questions destiny and love.',
    genres: ['Romance', 'Drama'],
    rating: 'PG-13',
    runtimeMinutes: 105,
    language: 'English',
    posterColor: '#6d28d9',
  },
];

export const theaters: Theater[] = [
  { id: 'th-grand', name: 'Grand Cinema', city: 'Bengaluru', rows: 6, seatsPerRow: 10 },
  { id: 'th-orion', name: 'Orion IMAX', city: 'Bengaluru', rows: 7, seatsPerRow: 12 },
  { id: 'th-lakeside', name: 'Lakeside Screens', city: 'Hyderabad', rows: 5, seatsPerRow: 8 },
];

/**
 * Shows are generated relative to process start so the catalogue always has
 * upcoming showtimes, no matter when the container is launched. They are
 * seeded for `horizonDays` starting today, and ids encode the calendar day
 * so re-seeding the same day is idempotent and the horizon can roll forward
 * without disturbing shows that are already on sale.
 */
export function buildShows(now = new Date(), horizonDays = 3): Show[] {
  const shows: Show[] = [];
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  // Each movie plays across 3 days at a rotating set of theaters and times.
  const slotHours = [11, 14.5, 18, 21.25];

  movies.forEach((movie, movieIndex) => {
    for (let dayOffset = 0; dayOffset < horizonDays; dayOffset++) {
      slotHours.forEach((slot, slotIndex) => {
        const theater = theaters[(movieIndex + slotIndex) % theaters.length]!;
        const startsAt = new Date(startOfToday);
        startsAt.setDate(startsAt.getDate() + dayOffset);
        startsAt.setMinutes(Math.round((slot % 1) * 60));
        startsAt.setHours(Math.floor(slot));

        // Skip showtimes that have already started today.
        if (startsAt.getTime() <= now.getTime()) return;

        // The date in the id makes re-seeding a day idempotent and keeps ids
        // stable across horizon refreshes, so bookings keep resolving.
        const date = startsAt.toISOString().slice(0, 10);
        const isPrimeTime = Math.floor(slot) >= 18;
        shows.push({
          id: `show-${movie.id}-${date}-${slotIndex}`,
          movieId: movie.id,
          theaterId: theater.id,
          screen: `Screen ${(slotIndex % 3) + 1}`,
          startsAt: startsAt.toISOString(),
          basePriceCents: isPrimeTime ? 45000 : 32000,
          currency: 'INR',
        });
      });
    }
  });

  return shows;
}
