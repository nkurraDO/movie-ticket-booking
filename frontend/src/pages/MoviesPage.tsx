import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Movie } from '../lib/api.ts';
import { EmptyState, ErrorBanner, Loading } from '../components/Feedback.tsx';

export default function MoviesPage() {
  const [movies, setMovies] = useState<Movie[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');

    // Debounce so typing in the search box does not spam the backend.
    const timer = setTimeout(() => {
      api
        .listMovies(search || undefined)
        .then((data) => {
          if (cancelled) return;
          setMovies(data.movies);
          setStatus('ready');
        })
        .catch((err: Error) => {
          if (cancelled) return;
          setError(err.message);
          setStatus('error');
        });
    }, search ? 250 : 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, reloadKey]);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Now Showing</h1>
          <p className="muted">Pick a film, choose a showtime, and grab your seats.</p>
        </div>
        <input
          className="input search"
          type="search"
          value={search}
          placeholder="Search films…"
          aria-label="Search films"
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {status === 'loading' && <Loading label="Loading films…" />}
      {status === 'error' && (
        <ErrorBanner message={error} onRetry={() => setReloadKey((key) => key + 1)} />
      )}
      {status === 'ready' && movies.length === 0 && (
        <EmptyState message={`No films match “${search}”.`} />
      )}

      {status === 'ready' && movies.length > 0 && (
        <div className="movie-grid">
          {movies.map((movie) => (
            <Link key={movie.id} to={`/movies/${movie.id}`} className="movie-card">
              <div className="poster" style={{ background: movie.posterColor }}>
                <span className="poster-title">{movie.title}</span>
              </div>
              <div className="movie-body">
                <h2>{movie.title}</h2>
                <p className="muted meta">
                  {movie.rating} · {movie.runtimeMinutes} min · {movie.language}
                </p>
                <p className="synopsis">{movie.synopsis}</p>
                <div className="chips">
                  {movie.genres.map((genre) => (
                    <span key={genre} className="chip">
                      {genre}
                    </span>
                  ))}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
