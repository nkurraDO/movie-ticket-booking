import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatMoney, formatShowtime, type Booking, type Movie, type Show, type Theater } from '../lib/api.ts';
import { ErrorBanner, Loading } from '../components/Feedback.tsx';

interface Details {
  booking: Booking;
  show: Show;
  movie: Movie;
  theater: Theater;
}

export default function ConfirmationPage() {
  const { reference = '' } = useParams();
  const [details, setDetails] = useState<Details | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getBooking(reference)
      .then((data) => {
        if (cancelled) return;
        setDetails(data);
        setStatus('ready');
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [reference]);

  async function cancelBooking() {
    if (!details) return;
    setCancelling(true);
    try {
      const { booking } = await api.cancelBooking(details.booking.reference);
      setDetails({ ...details, booking });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCancelling(false);
    }
  }

  if (status === 'loading') return <Loading label="Fetching your ticket…" />;
  if (status === 'error') return <ErrorBanner message={error} />;
  if (!details) return null;

  const { booking, show, movie, theater } = details;
  const cancelled = booking.status === 'cancelled';

  return (
    <section className="confirmation">
      <div className={`ticket ${cancelled ? 'cancelled' : ''}`}>
        <div className="ticket-stub" style={{ background: movie.posterColor }}>
          <span className="ticket-ref">{booking.reference}</span>
          <span className="ticket-status">{cancelled ? 'CANCELLED' : 'CONFIRMED'}</span>
        </div>

        <div className="ticket-body">
          <h1>{movie.title}</h1>
          <dl className="ticket-details">
            <div>
              <dt>Showtime</dt>
              <dd>{formatShowtime(show.startsAt)}</dd>
            </div>
            <div>
              <dt>Theater</dt>
              <dd>
                {theater.name}, {theater.city}
              </dd>
            </div>
            <div>
              <dt>Screen</dt>
              <dd>{show.screen}</dd>
            </div>
            <div>
              <dt>Seats</dt>
              <dd>{booking.seatIds.join(', ')}</dd>
            </div>
            <div>
              <dt>Booked by</dt>
              <dd>
                {booking.customerName}
                <br />
                <span className="muted small">{booking.email}</span>
              </dd>
            </div>
            <div>
              <dt>Total paid</dt>
              <dd>{formatMoney(booking.totalCents, booking.currency)}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="confirmation-actions">
        <Link to="/" className="btn btn-ghost">
          Book another film
        </Link>
        {!cancelled && (
          <button type="button" className="btn btn-danger" onClick={cancelBooking} disabled={cancelling}>
            {cancelling ? 'Cancelling…' : 'Cancel booking'}
          </button>
        )}
      </div>
    </section>
  );
}
