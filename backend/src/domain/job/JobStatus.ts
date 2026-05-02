export const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type ImprovementMode = 'append' | 'sibling';
