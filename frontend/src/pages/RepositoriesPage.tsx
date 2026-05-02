import { useEffect, useState, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Github } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';
import { CoverageBar } from '@/components/CoverageBar';
import { ErrorBanner } from '@/components/ErrorBanner';
import { api, RepositorySummary } from '@/api/client';

export function RepositoriesPage() {
  const [repos, setRepos] = useState<RepositorySummary[] | null>(null);
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = async () => {
    try {
      setRepos(await api.listRepositories());
    } catch (e) {
      setError(e);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.registerRepository(url);
      setUrl('');
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Hero */}
      <div className="space-y-2">
        <Badge variant="secondary" className="gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-brand" />
          AI-assisted test coverage
        </Badge>
        <h1 className="text-3xl font-semibold tracking-tight">
          Improve TypeScript coverage in any repo
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          Paste a GitHub URL — we clone it, find files with low test coverage, ask Claude
          to write the missing tests, and open a pull request with the results.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add a repository</CardTitle>
          <CardDescription>
            The repo must use Jest, Vitest, or Mocha (with nyc / c8). Your GitHub PAT
            needs permission to fork it — see <code>README.md</code> for details.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Github className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="url"
                placeholder="https://github.com/owner/repo"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={submitting}
                required
                className="pl-9"
              />
            </div>
            <Button type="submit" disabled={submitting || !url}>
              {submitting ? 'Adding…' : 'Add repository'}
            </Button>
          </form>
          {!!error && <ErrorBanner error={error} className="mt-3" />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tracked repositories</CardTitle>
          <CardDescription>
            Click a repo to view files needing improvement and queue jobs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {repos === null ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : repos.length === 0 ? (
            <p className="text-muted-foreground">No repositories yet — add one above.</p>
          ) : (
            <ul className="divide-y">
              {repos.map((r) => (
                <li
                  key={r.id}
                  className="group flex items-center justify-between gap-3 py-3"
                >
                  <Link
                    to={`/repositories/${r.id}`}
                    className="flex min-w-0 flex-1 items-center gap-3 hover:text-brand-deep"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand-deep">
                      <Github className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {r.owner}/{r.name}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {r.lastAnalyzedAt
                          ? `Last analyzed ${new Date(r.lastAnalyzedAt).toLocaleString()}`
                          : 'Not analyzed yet'}
                      </div>
                    </div>
                    <ArrowRight className="ml-1 h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
                  </Link>
                  <div className="flex items-center gap-3">
                    {r.overallLinesPct !== null ? (
                      <Tooltip
                        content={
                          <span>
                            Mean line-coverage across <strong>all</strong> {r.fileCount} TS
                            files in the latest scan. Files at or above the threshold are
                            hidden from the table on the next page; this number includes
                            them.
                          </span>
                        }
                      >
                        <span>
                          <CoverageBar pct={r.overallLinesPct} size="sm" />
                        </span>
                      </Tooltip>
                    ) : (
                      <Badge variant="outline">not analyzed</Badge>
                    )}
                    <Badge variant="secondary">{r.fileCount} files</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
