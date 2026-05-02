import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { JobStatusBadge } from '@/components/JobStatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Tooltip } from '@/components/ui/tooltip';
import { ErrorBanner } from '@/components/ErrorBanner';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { ApiError, api, JobDetail, RepositorySummary } from '@/api/client';

export function JobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [repo, setRepo] = useState<RepositorySummary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Cached via ref so it doesn't enter the load() dependency array — that
  // way load() keeps a stable identity and effects don't fire spuriously.
  const repoRef = useRef<RepositorySummary | null>(null);

  const load = useCallback(async () => {
    if (!jobId) return;
    try {
      const j = await api.getJob(jobId);
      setJob(j);
      // Lazily look up the repo's owner/name once for the breadcrumb. Cached
      // in a ref keyed by repositoryId — one fetch per detail-page entry.
      if (!repoRef.current || repoRef.current.id !== j.repositoryId) {
        const repos = await api.listRepositories();
        const found = repos.find((r) => r.id === j.repositoryId) ?? null;
        repoRef.current = found;
        setRepo(found);
      }
    } catch (e) {
      setError(e);
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while in-flight. Keyed only on the status string so a fresh
  // job object reference each tick doesn't tear down + recreate the interval.
  const status = job?.status;
  useEffect(() => {
    if (status !== 'pending' && status !== 'running') return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [status, load]);

  const onConfirmDelete = async () => {
    if (!jobId || !job) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteJob(jobId);
      setDeleteOpen(false);
      navigate(`/repositories/${job.repositoryId}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CANNOT_DELETE_IN_FLIGHT_JOB') {
        setError(e);
        setDeleteOpen(false);
      } else {
        setError(e);
      }
    } finally {
      setDeleting(false);
    }
  };

  if (!job) {
    return error ? <ErrorBanner error={error} /> : <p className="text-muted-foreground">Loading…</p>;
  }

  const inFlight = job.status === 'pending' || job.status === 'running';

  return (
    <div className="space-y-6">
      <Breadcrumbs
        items={[
          { label: 'Repositories', to: '/' },
          repo
            ? { label: `${repo.owner}/${repo.name}`, to: `/repositories/${repo.id}` }
            : { label: 'Repository', to: `/repositories/${job.repositoryId}` },
          { label: 'Job' },
        ]}
      />
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <CardTitle className="font-mono text-base">{job.targetFilePath}</CardTitle>
            <div className="flex items-center gap-2">
              <JobStatusBadge status={job.status} />
              {job.mode && <Badge variant="outline">{job.mode}</Badge>}
              <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                <Tooltip
                  content={
                    inFlight
                      ? 'Cannot delete a job that is still pending or running.'
                      : 'Delete this job and its logs. The PR (if any) is left intact on GitHub.'
                  }
                >
                  <DialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={inFlight}
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      Delete
                    </Button>
                  </DialogTrigger>
                </Tooltip>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Delete this job?</DialogTitle>
                    <DialogDescription>
                      The job for{' '}
                      <span className="font-mono">{job.targetFilePath}</span> and its
                      logs will be removed from the dashboard.{' '}
                      <strong>This cannot be undone.</strong>
                      <br />
                      <br />
                      The pull request on GitHub (if any) is <em>not</em> deleted — it
                      stays open for the upstream maintainer to review or merge.
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
                      onClick={() => void onConfirmDelete()}
                      disabled={deleting}
                    >
                      {deleting ? 'Deleting…' : 'Yes, delete'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex gap-6 text-muted-foreground">
            <div>
              <span className="font-medium text-foreground">Created:</span>{' '}
              {new Date(job.createdAt).toLocaleString()}
            </div>
            {job.startedAt && (
              <div>
                <span className="font-medium text-foreground">Started:</span>{' '}
                {new Date(job.startedAt).toLocaleString()}
              </div>
            )}
            {job.completedAt && (
              <div>
                <span className="font-medium text-foreground">Completed:</span>{' '}
                {new Date(job.completedAt).toLocaleString()}
              </div>
            )}
          </div>
          {job.coverageBefore !== null && (
            <p>
              Coverage:{' '}
              <span className="font-medium tabular-nums">
                {job.coverageBefore.toFixed(2)}%
              </span>{' '}
              → {' '}
              <span className="font-medium tabular-nums">
                {job.coverageAfter !== null
                  ? `${job.coverageAfter.toFixed(2)}%`
                  : 'pending'}
              </span>
            </p>
          )}
          {job.prUrl && (
            <p>
              Pull request:{' '}
              <a
                href={job.prUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline-offset-4 hover:underline"
              >
                {job.prUrl} ↗
              </a>
            </p>
          )}
          {job.error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive">
              <span className="font-medium">Error:</span> {job.error}
            </p>
          )}
          {!!error && <ErrorBanner error={error} className="mt-2" />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Logs</CardTitle>
        </CardHeader>
        <CardContent>
          {job.logs.length === 0 ? (
            <p className="text-muted-foreground">No log lines yet.</p>
          ) : (
            <pre className="max-h-[60vh] overflow-auto rounded-md border bg-muted/40 p-4 text-xs leading-relaxed">
              {job.logs.join('\n')}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
