// Lightweight fetch wrapper. The Vite dev server proxies /api → backend on
// :3000 (see vite.config.ts). In production we ship the same proxy via nginx.

export type AnalysisStatus = 'idle' | 'pending' | 'running' | 'failed';

export interface RepositorySummary {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  forkOwner: string | null;
  lastAnalyzedAt: string | null;
  overallLinesPct: number | null;
  fileCount: number;
  /**
   * Per-repository analyze-coverage lifecycle. The backend returns 202 from
   * POST /repositories/:id/refresh and the actual work runs on the per-repo
   * queue worker (which can take minutes). The dashboard polls this
   * summary to observe pending → running → idle/failed transitions.
   */
  analysisStatus: AnalysisStatus;
  analysisError: string | null;
  analysisStartedAt: string | null;
}

export interface FileCoverage {
  path: string;
  linesPct: number;
  branchesPct: number | null;
  functionsPct: number | null;
  uncoveredLines: number[];
  hasExistingTest: boolean | null;
}

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type ImprovementMode = 'append' | 'sibling' | null;

export interface Job {
  id: string;
  repositoryId: string;
  targetFilePath: string;
  status: JobStatus;
  mode: ImprovementMode;
  prUrl: string | null;
  coverageBefore: number | null;
  coverageAfter: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface JobDetail extends Job {
  logs: string[];
}

const BASE = '/api';

/**
 * Error thrown by the API client. Carries the backend's structured fields
 * (status, code, message) so callers can show the friendly message and
 * branch on the code if they want to.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: { message?: string | string[]; code?: string } | null = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* response body isn't JSON */
    }
    // The validation pipe returns `message: string[]`; domain errors return `message: string`.
    // Normalize to a single string.
    const rawMessage = parsed?.message;
    const friendly = Array.isArray(rawMessage)
      ? rawMessage.join('; ')
      : (rawMessage ?? text ?? `${res.status} ${res.statusText}`);
    throw new ApiError(friendly, res.status, parsed?.code);
  }
  return (await res.json()) as T;
}

export interface ServerConfig {
  defaultCoverageThreshold: number;
}

export const api = {
  getConfig: () => request<ServerConfig>('/config'),
  registerRepository: (url: string) =>
    request<RepositorySummary>('/repositories', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  listRepositories: () => request<RepositorySummary[]>('/repositories'),
  deleteRepository: async (id: string): Promise<void> => {
    const res = await fetch(`${BASE}/repositories/${id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      const text = await res.text().catch(() => '');
      let parsed: { message?: string; code?: string } | null = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON */
      }
      throw new ApiError(
        parsed?.message ?? text ?? `${res.status} ${res.statusText}`,
        res.status,
        parsed?.code,
      );
    }
  },
  // Returns 202 + the repo summary in `analysisStatus: 'pending'` state
  // immediately. The actual analysis runs on the backend's per-repo queue
  // and may take seconds to minutes. Poll listRepositories to observe
  // status transitions.
  refreshRepository: (id: string) =>
    request<RepositorySummary>(`/repositories/${id}/refresh`, {
      method: 'POST',
    }),
  listLowCoverageFiles: (id: string, threshold = 80) =>
    request<FileCoverage[]>(`/repositories/${id}/files?threshold=${threshold}`),
  requestImprovement: (id: string, filePath: string) =>
    request<Job>(`/repositories/${id}/jobs`, {
      method: 'POST',
      body: JSON.stringify({ filePath }),
    }),
  getJob: (jobId: string) => request<JobDetail>(`/jobs/${jobId}`),
  listJobs: (repositoryId: string) => request<Job[]>(`/jobs?repositoryId=${repositoryId}`),
  deleteJob: async (jobId: string): Promise<void> => {
    const res = await fetch(`${BASE}/jobs/${jobId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      const text = await res.text().catch(() => '');
      let parsed: { message?: string; code?: string } | null = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON */
      }
      throw new ApiError(
        parsed?.message ?? text ?? `${res.status} ${res.statusText}`,
        res.status,
        parsed?.code,
      );
    }
  },
};
