import { Badge } from '@/components/ui/badge';
import type { JobStatus } from '@/api/client';

const VARIANT_BY_STATUS: Record<
  JobStatus,
  'default' | 'secondary' | 'destructive' | 'success' | 'warning'
> = {
  pending: 'secondary',
  running: 'warning',
  succeeded: 'success',
  failed: 'destructive',
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return <Badge variant={VARIANT_BY_STATUS[status]}>{status}</Badge>;
}
