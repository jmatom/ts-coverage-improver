/**
 * Read-side DTOs shared by application use cases and HTTP controllers.
 *
 * Kept as plain data shapes (no class-validator decorators here — those live
 * on the request DTOs in the Nest layer). These outputs are what the
 * dashboard renders.
 */

export interface RepositorySummaryDto {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  forkOwner: string | null;
  lastAnalyzedAt: string | null;
  overallLinesPct: number | null; // null if no scan yet
  fileCount: number;
  /**
   * Per-repository analyze-coverage lifecycle. Surfaced so the dashboard
   * can render a live status while the worker runs (which can take
   * minutes for a real-world repo). See Repository.analysisStatus for
   * the transitions.
   */
  analysisStatus: 'idle' | 'pending' | 'running' | 'failed';
  analysisError: string | null;
  analysisStartedAt: string | null;
}

export interface FileCoverageDto {
  path: string;
  linesPct: number;
  branchesPct: number | null;
  functionsPct: number | null;
  uncoveredLines: number[];
  hasExistingTest: boolean | null; // populated by use case if known; else null
}

export interface JobDto {
  id: string;
  repositoryId: string;
  targetFilePath: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  mode: 'append' | 'sibling' | null;
  prUrl: string | null;
  coverageBefore: number | null;
  coverageAfter: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface JobDetailDto extends JobDto {
  logs: string[];
}
