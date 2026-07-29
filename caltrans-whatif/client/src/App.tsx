import { createBrowserRouter, RouterProvider } from 'react-router';
import { useState } from 'react';
import { ArchitecturePage } from './pages/architecture/ArchitecturePage';
import { TrafficMapPage } from './pages/map/TrafficMapPage';

type AppTab = 'map' | 'architecture';

export function paneVisibilityClass(activeTab: AppTab, paneTab: AppTab) {
  return activeTab === paneTab ? 'block' : 'hidden';
}

export function Layout() {
  const [activeTab, setActiveTab] = useState<AppTab>('map');

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-2 md:px-6">
        <div>
          <h1 className="text-lg font-semibold text-foreground">California Traffic What-If</h1>
          <p className="text-xs text-muted-foreground">Baseline animation · AI congestion advisor</p>
        </div>
        <nav aria-label="Primary" className="flex rounded-full border bg-muted p-1">
          <button
            type="button"
            aria-pressed={activeTab === 'map'}
            className={`rounded-full px-3 py-1 text-sm font-semibold transition ${
              activeTab === 'map' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
            }`}
            onClick={() => setActiveTab('map')}
          >
            Map
          </button>
          <button
            type="button"
            aria-pressed={activeTab === 'architecture'}
            className={`rounded-full px-3 py-1 text-sm font-semibold transition ${
              activeTab === 'architecture' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
            }`}
            onClick={() => setActiveTab('architecture')}
          >
            Architecture
          </button>
        </nav>
        <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">
          lanl.caltrans_traffic · DBSQL + H3
        </span>
      </header>
      <main className="flex-1 p-3 md:p-4">
        <section aria-label="Traffic map" className={paneVisibilityClass(activeTab, 'map')}>
          <TrafficMapPage />
        </section>
        <section aria-label="Architecture" className={paneVisibilityClass(activeTab, 'architecture')}>
          <ArchitecturePage />
        </section>
      </main>
    </div>
  );
}

const router = createBrowserRouter([{ path: '*', element: <Layout /> }]);

export default function App() {
  return <RouterProvider router={router} />;
}
