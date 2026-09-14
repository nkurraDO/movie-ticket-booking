import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  formatMoney,
  formatShowtime,
  type SeatMapResponse,
} from '../lib/api.ts';
import { ErrorBanner, Loading } from '../components/Feedback.tsx';

export default function SeatsPage() {
  const { showId = '' } = useParams();
  const navigate = useNavigate();

  const [data, setData] = useState<SeatMapResponse | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  function loadSeats() {
    setStatus('loading');
    api
      .getSeatMap(showId)
      .then((response) => {
        setData(response);
        // Drop any selection that someone else booked while we were away.
        setSelected((current) =>
          current.filter((id) =>
            response.seats.some((seat) => seat.id === id && seat.status === 'available'),
          ),
        );
        setStatus('ready');
      })
      .catch((err: Error) => {
        setError(err.message);
        setStatus('error');
      });
  }

  useEffect(loadSeats, [showId]);

  const rows = useMemo(() => {
    if (!data) return [];
    const grouped = new Map<string, typeof data.seats>();
    for (const seat of data.seats) {
      grouped.set(seat.row, [...(grouped.get(seat.row) ?? []), seat]);
    }
    return [...grouped.entries()];
  }, [data]);

  const selectedSeats = useMemo(
    () => (data ? data.seats.filter((seat) => selected.includes(seat.id)) : []),
    [data, selected],
  );
  const total = selectedSeats.reduce((sum, seat) => sum + seat.priceCents, 0);

  function toggleSeat(seatId: string, available: boolean) {
    if (!available || !data) return;
    setFormError('');
    setSelected((current) => {
      if (current.includes(seatId)) return current.filter((id) => id !== seatId);
      if (current.length >= data.maxSeatsPerBooking) {
        setFormError(`You can book at most ${data.maxSeatsPerBooking} seats at a time.`);
        return current;
      }
      return [...current, seatId];
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!data || selected.length === 0) {
      setFormError('Select at least one seat.');
      return;
    }

    setSubmitting(true);
    setFormError('');
    try {
      const { booking } = await api.createBooking({
        showId,
        seatIds: selected,
        customerName: name,
        email,
      });
      navigate(`/bookings/${booking.reference}`);
    } catch (err) {
      setFormError((err as Error).message);
      // Somebody else may have taken these seats, so refresh the map.
      loadSeats();
    } finally {
      setSubmitting(false);
    }
  }

  if (status === 'loading') return <Loading label="Loading seat map…" />;
  if (status === 'error') return <ErrorBanner message={error} onRetry={loadSeats} />;
  if (!data) return null;

  return (
    <section>
      <Link to={`/movies/${data.movie.id}`} className="back-link">
        ← Showtimes
      </Link>

      <div className="page-head">
        <div>
          <h1>{data.movie.title}</h1>
          <p className="muted">
            {formatShowtime(data.show.startsAt)} · {data.theater.name}, {data.theater.city} ·{' '}
            {data.show.screen}
          </p>
        </div>
        <span className="badge">{data.available} seats left</span>
      </div>

      <div className="booking-layout">
        <div className="auditorium">
          <div className="screen-bar">SCREEN</div>

          {rows.map(([row, seats]) => (
            <div key={row} className="seat-row">
              <span className="row-label">{row}</span>
              {seats.map((seat) => {
                const isSelected = selected.includes(seat.id);
                const available = seat.status === 'available';
                return (
                  <button
                    key={seat.id}
                    type="button"
                    className={`seat ${seat.seatClass} ${seat.status} ${isSelected ? 'selected' : ''}`}
                    disabled={!available}
                    aria-pressed={isSelected}
                    aria-label={`Seat ${seat.id}, ${seat.seatClass}, ${formatMoney(
                      seat.priceCents,
                      data.show.currency,
                    )}, ${seat.status}`}
                    title={`${seat.id} · ${seat.seatClass} · ${formatMoney(
                      seat.priceCents,
                      data.show.currency,
                    )}`}
                    onClick={() => toggleSeat(seat.id, available)}
                  >
                    {seat.number}
                  </button>
                );
              })}
            </div>
          ))}

          <div className="legend">
            <span>
              <i className="swatch available" /> Available
            </span>
            <span>
              <i className="swatch selected" /> Selected
            </span>
            <span>
              <i className="swatch held" /> On hold
            </span>
            <span>
              <i className="swatch booked" /> Booked
            </span>
          </div>
        </div>

        <aside className="checkout">
          <h2>Your order</h2>

          {selectedSeats.length === 0 ? (
            <p className="muted">No seats selected yet. Tap a seat to begin.</p>
          ) : (
            <ul className="order-list">
              {selectedSeats.map((seat) => (
                <li key={seat.id}>
                  <span>
                    <strong>{seat.id}</strong> <span className="muted small">{seat.seatClass}</span>
                  </span>
                  <span>{formatMoney(seat.priceCents, data.show.currency)}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="order-total">
            <span>Total</span>
            <strong>{formatMoney(total, data.show.currency)}</strong>
          </div>

          <form onSubmit={submit} className="checkout-form">
            <label>
              Full name
              <input
                className="input"
                value={name}
                required
                minLength={2}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ada Lovelace"
              />
            </label>
            <label>
              Email
              <input
                className="input"
                type="email"
                value={email}
                required
                onChange={(event) => setEmail(event.target.value)}
                placeholder="ada@example.com"
              />
            </label>

            {formError && <p className="form-error">{formError}</p>}

            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting || selected.length === 0}
            >
              {submitting ? 'Confirming…' : `Confirm ${selected.length || ''} seat${selected.length === 1 ? '' : 's'}`}
            </button>
          </form>
        </aside>
      </div>
    </section>
  );
}
