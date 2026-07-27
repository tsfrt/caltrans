import { createBrowserRouter, RouterProvider } from 'react-router';
import { TrafficMapPage } from './pages/map/TrafficMapPage';

/**
 * California Traffic What-If — Milestone 1.
 *
 * Single-surface app: the animated map IS the product, so there is no nav to speak of.
 * M2 (scenario levers) and M3 (saved scenarios, AI narration) add sibling routes here.
 */
function Layout() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center gap-3 border-b px-4 py-2 md:px-6">
        <h1 className="text-lg font-semibold text-foreground">California Traffic What-If</h1>
        <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          Milestone 1 · baseline animation
        </span>
        <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">
          lanl.caltrans_traffic · DBSQL + H3
        </span>
      </header>
      <main className="flex-1 p-3 md:p-4">
        <TrafficMapPage />
      </main>
    </div>
  );
}

const router = createBrowserRouter([{ path: '*', element: <Layout /> }]);

export default function App() {
  return <RouterProvider router={router} />;
}
