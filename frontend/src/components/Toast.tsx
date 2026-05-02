import { useEffect } from 'react';
import { CheckCircle2, X, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastInput {
  tone: ToastTone;
  message: string;
}

/**
 * Lightweight transient notification, fixed bottom-right. Auto-dismisses
 * after `durationMs` (default 3.5s) or via the close button. The page owns
 * the toast state — render `<Toast>` only while the state is non-null.
 */
export function Toast({
  tone,
  message,
  onDismiss,
  durationMs = 3500,
}: ToastInput & {
  onDismiss: () => void;
  durationMs?: number;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(t);
  }, [onDismiss, durationMs]);

  const Icon = tone === 'success' ? CheckCircle2 : tone === 'error' ? AlertCircle : AlertCircle;
  const accent =
    tone === 'success'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
      : tone === 'error'
        ? 'border-destructive/30 bg-destructive/10 text-destructive'
        : 'border-border bg-card text-foreground';

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-3 rounded-lg border p-3 pr-2 shadow-lg',
        'animate-in slide-in-from-bottom-4 fade-in-0',
        accent,
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1 text-sm leading-snug">{message}</div>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded-sm opacity-70 transition-opacity hover:opacity-100"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
