import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatMoney, type Movie, type Show } from '../lib/api.ts';
import { EmptyState, ErrorBanner, Loading } from '../components/Feedback.tsx';

export default function MoviePage() {
  const { movieId = '' } = useParams();
  const [movie, setMovie] = useState<Movie | null>(null);
  const [shows, setShows] = useState<Show[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    api
      .getMovie(movieId)
      .then((data) => {
        if (cancelled) return;
        setMovie(data.movie);
        setShows(data.shows);
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
  }, [movieId]);

  // Group showtimes by calendar day so the page reads like a cinema listing.
  const showsByDate = useMemo(() => {
    const groups = new Map<string, Show[]>();
    for (const show of shows) {
      const day = new Date(show.startsAt).toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      });
      groups.set(day, [...(groups.get(day) ?? []), show]);
    }
    return [...groups.entries()];
  }, [shows]);

  if (status === 'loading') return <Loading label="Loading showtimes…" />;
  if (status === 'error') return <ErrorBanner message={error} />;
  if (!movie) return <EmptyState message="Film not found." />;

  return (
    <section>
      <Link to="/" className="back-link">
        ← All films
      </Link>

      <div className="movie-hero">
        <div className="poster poster-lg" style={{ background: movie.posterColor }}>
          <span className="poster-title">{movie.title}</span>
        </div>
        <div>
          <h1>{movie.title}</h1>
          <p className="muted meta">
            {movie.rating} · {movie.runtimeMinutes} min · {movie.language}
          </p>
          <p>{movie.synopsis}</p>
          <div className="chips">
            {movie.genres.map((genre) => (
              <span key={genre} className="chip">
                {genre}
              </span>
            ))}
          </div>
        </div>
      </div>

      <h2 className="section-title">Showtimes</h2>
      {showsByDate.length === 0 && <EmptyState message="No upcoming showtimes for this film." />}

      {showsByDate.map(([day, dayShows]) => (
        <div key={day} className="showtime-day">
          <h3>{day}</h3>
          <div className="showtime-grid">
            {dayShows.map((show) => (
              <Link key={show.id} to={`/shows/${show.id}/seats`} className="showtime-card">
                <span className="showtime-clock">
                  {new Date(show.startsAt).toLocaleTimeString(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
                <span className="muted">{show.theater?.name}</span>
                <span className="muted small">
                  {show.screen} · from {formatMoney(show.basePriceCents, show.currency)}
                </span>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
