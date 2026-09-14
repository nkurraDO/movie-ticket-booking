import { Link, NavLink, Outlet } from 'react-router-dom';

export default function App() {
  return (
    <div className="app">
      <header className="site-header">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            ◉
          </span>
          CineBook
        </Link>
        <nav className="site-nav">
          <NavLink to="/" end>
            Now Showing
          </NavLink>
          <NavLink to="/bookings">My Bookings</NavLink>
        </nav>
      </header>

      <main className="site-main">
        <Outlet />
      </main>

      <footer className="site-footer">
        <span>CineBook — a demo movie ticket booking system.</span>
        <span>Frontend and backend run as separate services.</span>
      </footer>
    </div>
  );
}
