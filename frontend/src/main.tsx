import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, NavLink, Outlet } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RepositoriesPage } from '@/pages/RepositoriesPage';
import { RepositoryDetailPage } from '@/pages/RepositoryDetailPage';
import { JobDetailPage } from '@/pages/JobDetailPage';
import './index.css';

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-cta shadow-card">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
          aria-hidden
        >
          <path d="M3 12l4 4 14-14" />
          <path d="M12 21a9 9 0 100-18 9 9 0 000 18z" opacity="0.35" />
        </svg>
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-[15px] font-semibold tracking-tight">Coverage Improver</span>
      </div>
    </div>
  );
}

function Layout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between gap-6">
          <NavLink to="/" className="hover:opacity-90">
            <Logo />
          </NavLink>
          <nav className="flex items-center gap-1 text-sm">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 transition-colors ${
                  isActive
                    ? 'bg-brand-soft text-brand-deep'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`
              }
            >
              Repositories
            </NavLink>
          </nav>
        </div>
      </header>

      <div className="bg-brand-gradient">
        <main className="container py-10">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={150}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<RepositoriesPage />} />
            <Route path="/repositories/:id" element={<RepositoryDetailPage />} />
            <Route path="/jobs/:jobId" element={<JobDetailPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </React.StrictMode>,
);
