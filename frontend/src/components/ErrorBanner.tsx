import { AlertTriangle } from 'lucide-react';
import { ApiError } from '@/api/client';
import { cn } from '@/lib/utils';

/**
 * Renders an error from the API in a way that's actionable for the user.
 * Uses the structured `code` field when present — backend domain errors
 * carry a stable code that we can document or branch on later.
 */
export function ErrorBanner({
  error,
  className,
}: {
  error: unknown;
  className?: string;
}) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof ApiError ? error.code : undefined;
  const status = error instanceof ApiError ? error.status : undefined;

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive',
        className,
      )}
      role="alert"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1 space-y-1">
        <div className="font-medium leading-snug">{message}</div>
        {(code || status) && (
          <div className="font-mono text-[10px] uppercase tracking-wide text-destructive/70">
            {code ?? `HTTP ${status}`}
          </div>
        )}
      </div>
    </div>
  );
}
