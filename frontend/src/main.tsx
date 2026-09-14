import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App.tsx';
import MoviesPage from './pages/MoviesPage.tsx';
import MoviePage from './pages/MoviePage.tsx';
import SeatsPage from './pages/SeatsPage.tsx';
import ConfirmationPage from './pages/ConfirmationPage.tsx';
import BookingsPage from './pages/BookingsPage.tsx';
import './styles.css';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <MoviesPage /> },
      { path: 'movies/:movieId', element: <MoviePage /> },
      { path: 'shows/:showId/seats', element: <SeatsPage /> },
      { path: 'bookings/:reference', element: <ConfirmationPage /> },
      { path: 'bookings', element: <BookingsPage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
