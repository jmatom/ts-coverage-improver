import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ExternalLink, Eye, Info, MoreHorizontal, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CoverageBar } from '@/components/CoverageBar';
import { JobStatusBadge } from '@/components/JobStatusBadge';
import { ErrorBanner } from '@/components/ErrorBanner';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Toast, ToastInput } from '@/components/Toast';
import { Tooltip } from '@/components/ui/tooltip';
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/utils';
import { ApiError, api, FileCoverage, Job, RepositorySummary } from '@/api/client';

export function RepositoryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [repo, setRepo] = useState<RepositorySummary | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [files, setFiles] = useState<FileCoverage[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  // Initialised from `/api/config` on mount so the default mirrors the
  // server's `DEFAULT_COVERAGE_THRESHOLD` rather than a hardcoded literal.
  const [threshold, setThreshold] = useState(80);
  const [thresholdReady, setThresholdReady] = useState(false);
  const [requesting, setRequesting] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [toast, setToast] = useState<ToastInput | null>(null);
  const [jobToDelete, setJobToDelete] = useState<Job | null>(null);
  const [deletingJob, setDeletingJob] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [list, repoList, jobList] = await Promise.all([
        api.listLowCoverageFiles(id, threshold),
        api.listRepositories(),
        api.listJobs(id),
      ]);
      setFiles(list);
      setJobs(jobList);
      setRepo(repoList.find((r) => r.id === id) ?? null);
    } catch (e) {
      setError(e);
    }
  }, [id, threshold]);

  // Fetch the server-side default threshold once and seed the input. Loading
  // gates the first list-files fetch so we don't briefly hit the API with the
  // hardcoded fallback.
  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((cfg) => {
        if (cancelled) return;
        setThreshold(cfg.defaultCoverageThreshold);
        setThresholdReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setThresholdReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!thresholdReady) return;
    void load();
  }, [load, thresholdReady]);

  // Poll while any job is in-flight, OR while an analysis is in flight.
  // Analyze is async (HTTP 202 returns immediately while a worker on the
  // per-repo queue does the actual clone + install + tests, which can take
  // minutes), so the dashboard observes progress by polling the repository
  // summary's `analysisStatus`.
  const analyzing = repo?.analysisStatus === 'pending' || repo?.analysisStatus === 'running';
  useEffect(() => {
    const jobInFlight = jobs.some((j) => j.status === 'pending' || j.status === 'running');
    if (!jobInFlight && !analyzing) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [jobs, analyzing, load]);

  const onAnalyze = async () => {
    if (!id) return;
    setError(null);
    try {
      // Returns 202 immediately with analysisStatus='pending'. Update the
      // local repo so the button flips to "Analyzing…" without waiting
      // for the next 3s poll tick.
      const updated = await api.refreshRepository(id);
      setRepo(updated);
    } catch (e) {
      setError(e);
    }
  };

  const onImprove = async (filePath: string) => {
    if (!id) return;
    setRequesting(filePath);
    setError(null);
    try {
      await api.requestImprovement(id, filePath);
      await load();
      setToast({ tone: 'success', message: `Job queued for ${filePath}.` });
    } catch (e) {
      // Idempotency: if a job for this file is already pending/running, the
      // backend returns 409 with code JOB_ALREADY_IN_FLIGHT. Surface that as
      // a transient toast (not a persistent banner) — it's expected, not a bug.
      if (e instanceof ApiError && e.code === 'JOB_ALREADY_IN_FLIGHT') {
        setToast({ tone: 'info', message: e.message });
      } else {
        setError(e);
      }
    } finally {
      setRequesting(null);
    }
  };

  const onConfirmDeleteJob = async () => {
    if (!jobToDelete) return;
    setDeletingJob(true);
    try {
      await api.deleteJob(jobToDelete.id);
      await load();
      setToast({ tone: 'success', message: 'Job deleted.' });
      setJobToDelete(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CANNOT_DELETE_IN_FLIGHT_JOB') {
        setToast({ tone: 'info', message: e.message });
        setJobToDelete(null);
      } else {
        setError(e);
      }
    } finally {
      setDeletingJob(false);
    }
  };

  const onDelete = async () => {
    if (!id) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteRepository(id);
      setDeleteOpen(false);
      navigate('/');
    } catch (e) {
      setError(e);
    } finally {
      setDeleting(false);
    }
  };

  const inFlightForFile = (path: string): boolean =>
    jobs.some(
      (j) =>
        j.targetFilePath === path && (j.status === 'pending' || j.status === 'running'),
    );

  if (!repo) {
    return <p className="text-muted-foreground">Loading…</p>;
  }

  const renderToast = toast ? (
    <Toast
      tone={toast.tone}
      message={toast.message}
      onDismiss={() => setToast(null)}
    />
  ) : null;

  const filesUnderThresholdCount = files.length;
  const overall = repo.overallLinesPct;

  return (
    <div className="space-y-6">
      {renderToast}
      <Breadcrumbs
        items={[
          { label: 'Repositories', to: '/' },
          { label: `${repo.owner}/${repo.name}` },
        ]}
      />
      {/* Repo header card */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <Badge variant="secondary">Repository</Badge>
              <CardTitle className="text-2xl">
                {repo.owner}/{repo.name}
              </CardTitle>
              <CardDescription>
                Default branch <code className="font-mono">{repo.defaultBranch}</code>
                {analyzing
                  ? repo.analysisStatus === 'pending'
                    ? ' · analysis queued…'
                    : repo.analysisStartedAt
                      ? ` · analyzing since ${new Date(repo.analysisStartedAt).toLocaleTimeString()}`
                      : ' · analyzing…'
                  : repo.lastAnalyzedAt
                    ? ` · last analyzed ${new Date(repo.lastAnalyzedAt).toLocaleString()}`
                    : ' · not analyzed yet'}
              </CardDescription>
              {repo.analysisStatus === 'failed' && repo.analysisError && (
                <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <strong>Last analysis failed:</strong> {repo.analysisError}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={onAnalyze} disabled={analyzing} variant="outline">
                <RefreshCw className={`mr-2 h-4 w-4 ${analyzing ? 'animate-spin' : ''}`} />
                {analyzing
                  ? repo.analysisStatus === 'pending'
                    ? 'Queued…'
                    : 'Analyzing…'
                  : repo.lastAnalyzedAt
                    ? 'Re-analyze'
                    : 'Analyze'}
              </Button>
              <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                <Tooltip content="Remove this repository from the dashboard. The bot's GitHub fork is left intact (it may have open PRs).">
                  <DialogTrigger asChild>
                    <Button variant="outline" className="text-destructive hover:bg-destructive/10 hover:text-destructive">
                      <Trash2 className="mr-2 h-4 w-4" />
                      Remove
                    </Button>
                  </DialogTrigger>
                </Tooltip>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Remove this repository?</DialogTitle>
                    <DialogDescription>
                      <span className="font-mono">{repo.owner}/{repo.name}</span> and all
                      its coverage reports, improvement jobs, and logs will be deleted
                      from the dashboard. <strong>This cannot be undone.</strong>
                      <br />
                      <br />
                      The bot's GitHub fork (if any) is <em>not</em> deleted — it may have
                      open PRs. Remove it manually on GitHub if you want it gone.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => setDeleteOpen(false)}
                      disabled={deleting}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => void onDelete()}
                      disabled={deleting}
                    >
                      {deleting ? 'Removing…' : 'Yes, remove'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat
              label="Overall coverage"
              tooltip={
                <>
                  Mean line-coverage across <strong>all</strong> {repo.fileCount} TS files
                  in the most recent scan — including files already at 100%. Click{' '}
                  <strong>Re-analyze</strong> to refresh after a PR merges.
                </>
              }
            >
              {overall !== null ? <CoverageBar pct={overall} threshold={threshold} /> : '—'}
            </Stat>

            <Stat
              label="Files in latest scan"
              tooltip="Total TypeScript files for which we have coverage data. This is the denominator behind Overall coverage."
            >
              <span className="text-xl font-semibold tabular-nums">{repo.fileCount}</span>
            </Stat>

            <Stat
              label={`Below ${threshold}% threshold`}
              tooltip={
                <>
                  Files whose line-coverage is strictly below the threshold (
                  <em>configurable</em> on the right). Only these appear in the table —
                  the rest are already &ldquo;good enough&rdquo; by your definition.
                </>
              }
            >
              <span className="text-xl font-semibold tabular-nums">
                {filesUnderThresholdCount}
              </span>
            </Stat>
          </div>
        </CardContent>
      </Card>

      {/* Low-coverage files table */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <CardTitle>Low-coverage files</CardTitle>
              <CardDescription>
                Click <strong>Improve</strong> to ask the AI to write the missing tests
                and open a PR.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Tooltip content="Files with line-coverage strictly below this percentage are shown in the table. Lower it to surface more files; raise it to focus on the very worst.">
                <label
                  htmlFor="threshold"
                  className="flex cursor-help items-center gap-1 text-muted-foreground"
                >
                  Threshold <Info className="h-3.5 w-3.5" />
                </label>
              </Tooltip>
              <Input
                id="threshold"
                type="number"
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                min={0}
                max={100}
                className="h-9 w-20"
              />
              <span className="text-muted-foreground">%</span>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {files.length === 0 ? (
            <p className="text-muted-foreground">
              {repo.lastAnalyzedAt
                ? `No files below ${threshold}% — nice work.`
                : 'No coverage data yet — click Analyze.'}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Lines</TableHead>
                  <TableHead>
                    <Tooltip content="Branch coverage (`if`/`else`/ternary outcomes). `—` means the project's coverage tool did not report branches.">
                      <span className="cursor-help underline decoration-dotted underline-offset-4">
                        Branches
                      </span>
                    </Tooltip>
                  </TableHead>
                  <TableHead>
                    <Tooltip content="Function coverage. `—` means the project's coverage tool did not report functions.">
                      <span className="cursor-help underline decoration-dotted underline-offset-4">
                        Functions
                      </span>
                    </Tooltip>
                  </TableHead>
                  <TableHead>
                    <Tooltip content={<>Whether a sibling test file (e.g. <code>foo.test.ts</code>, <code>__tests__/foo.test.ts</code>) was found at last analysis. <strong>Append</strong> = AI will add cases to the existing file; <strong>Sibling</strong> = AI will create a new test file.</>}>
                      <span className="cursor-help underline decoration-dotted underline-offset-4">
                        Tests
                      </span>
                    </Tooltip>
                  </TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {files.map((f) => {
                  const inFlight = inFlightForFile(f.path);
                  return (
                    <TableRow key={f.path}>
                      <TableCell className="font-mono text-xs">{f.path}</TableCell>
                      <TableCell>
                        <CoverageBar pct={f.linesPct} threshold={threshold} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {f.branchesPct !== null ? `${f.branchesPct.toFixed(1)}%` : '—'}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {f.functionsPct !== null ? `${f.functionsPct.toFixed(1)}%` : '—'}
                      </TableCell>
                      <TableCell className="text-xs">
                        {f.hasExistingTest === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : f.hasExistingTest ? (
                          <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-700">
                            Append
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">
                            Sibling
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Tooltip
                          content={
                            inFlight
                              ? 'A job is already pending or running for this file. Clicking again will return a 409 from the backend (idempotency guard).'
                              : 'Clone the repo, ask Claude to write tests, validate (AST + tests + coverage delta), then open a fork PR.'
                          }
                        >
                          <span>
                            <Button
                              size="sm"
                              variant={inFlight ? 'outline' : 'default'}
                              disabled={requesting === f.path}
                              onClick={() => void onImprove(f.path)}
                            >
                              {requesting === f.path ? (
                                'Queueing…'
                              ) : (
                                <>
                                  <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                                  Improve
                                </>
                              )}
                            </Button>
                          </span>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {!!error && <ErrorBanner error={error} className="mt-3" />}
        </CardContent>
      </Card>

      {/* Jobs */}
      <Card>
        <CardHeader>
          <CardTitle>Improvement jobs</CardTitle>
          <CardDescription>
            Newest first. Within a repo, jobs run in order; across repos they run in
            parallel.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <p className="text-muted-foreground">No jobs yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Tooltip content="When this job was queued. Newest jobs appear at the top.">
                      <span className="cursor-help underline decoration-dotted underline-offset-4">
                        Queued
                      </span>
                    </Tooltip>
                  </TableHead>
                  <TableHead>File</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>
                    <Tooltip content={<>“append” = added cases to an existing test file; “sibling” = wrote a new <code>.generated.test.ts</code> alongside the source.</>}>
                      <span className="cursor-help underline decoration-dotted underline-offset-4">Mode</span>
                    </Tooltip>
                  </TableHead>
                  <TableHead>
                    <Tooltip content="Target file's line coverage before → after the AI's PR. The job only succeeds if this strictly increased.">
                      <span className="cursor-help underline decoration-dotted underline-offset-4">Coverage</span>
                    </Tooltip>
                  </TableHead>
                  <TableHead className="w-12 text-right" aria-label="Actions" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((j) => {
                  const inFlight = j.status === 'pending' || j.status === 'running';
                  return (
                    <TableRow
                      key={j.id}
                      onClick={() => navigate(`/jobs/${j.id}`)}
                      className="cursor-pointer hover:bg-muted/40"
                    >
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        <Tooltip content={formatAbsoluteTime(j.createdAt)}>
                          <span className="cursor-help">
                            {formatRelativeTime(j.createdAt)}
                          </span>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{j.targetFilePath}</TableCell>
                      <TableCell>
                        <JobStatusBadge status={j.status} />
                      </TableCell>
                      <TableCell className="text-xs">
                        {j.mode ? (
                          <Badge variant="outline">{j.mode}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {j.coverageBefore !== null
                          ? `${j.coverageBefore.toFixed(0)}%`
                          : '—'}
                        {' → '}
                        {j.coverageAfter !== null
                          ? `${j.coverageAfter.toFixed(0)}%`
                          : '—'}
                      </TableCell>
                      <TableCell
                        className="text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              aria-label="Job actions"
                              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => navigate(`/jobs/${j.id}`)}>
                              <Eye className="h-4 w-4" />
                              View details
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={!j.prUrl}
                              onSelect={() => {
                                if (j.prUrl) window.open(j.prUrl, '_blank', 'noopener,noreferrer');
                              }}
                            >
                              <ExternalLink className="h-4 w-4" />
                              Visit PR
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              destructive
                              disabled={inFlight}
                              onSelect={() => setJobToDelete(j)}
                            >
                              <Trash2 className="h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Dialog
        open={!!jobToDelete}
        onOpenChange={(open) => {
          if (!open) setJobToDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this job?</DialogTitle>
            <DialogDescription>
              The job for{' '}
              <span className="font-mono">{jobToDelete?.targetFilePath}</span> and its
              logs will be removed from the dashboard.{' '}
              <strong>This cannot be undone.</strong>
              <br />
              <br />
              The pull request on GitHub (if any) is <em>not</em> deleted — it stays
              open for the upstream maintainer to review or merge.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setJobToDelete(null)}
              disabled={deletingJob}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void onConfirmDeleteJob()}
              disabled={deletingJob}
            >
              {deletingJob ? 'Deleting…' : 'Yes, delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({
  label,
  tooltip,
  children,
}: {
  label: string;
  tooltip: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <Tooltip content={tooltip}>
        <div className="flex cursor-help items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
          <Info className="h-3 w-3" />
        </div>
      </Tooltip>
      <div className="mt-2">{children}</div>
    </div>
  );
}
