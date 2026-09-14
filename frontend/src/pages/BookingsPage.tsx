import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, formatMoney, type Booking } from '../lib/api.ts';
import { EmptyState, ErrorBanner } from '../components/Feedback.tsx';

export default function BookingsPage() {
  const [email, setEmail] = useState('');
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function lookup(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await api.listBookings(email);
      setBookings(data.bookings);
    } catch (err) {
      setError((err as Error).message);
      setBookings(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section>
      <h1>My Bookings</h1>
      <p className="muted">Enter the email you booked with to retrieve your tickets.</p>

      <form className="lookup-form" onSubmit={lookup}>
        <input
          className="input"
          type="email"
          required
          value={email}
          placeholder="ada@example.com"
          aria-label="Email address"
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Searching…' : 'Find bookings'}
        </button>
      </form>

      {error && <ErrorBanner message={error} />}
      {bookings?.length === 0 && <EmptyState message="No bookings found for that email." />}

      {bookings && bookings.length > 0 && (
        <ul className="booking-list">
          {bookings.map((booking) => (
            <li key={booking.reference}>
              <Link to={`/bookings/${booking.reference}`}>
                <span className="booking-ref">{booking.reference}</span>
                <span className="muted">{booking.seatIds.join(', ')}</span>
                <span>{formatMoney(booking.totalCents, booking.currency)}</span>
                <span className={`pill ${booking.status}`}>{booking.status}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
