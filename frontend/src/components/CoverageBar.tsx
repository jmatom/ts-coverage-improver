import { cn } from '@/lib/utils';

export function CoverageBar({
  pct,
  threshold = 80,
  size = 'md',
}: {
  pct: number;
  threshold?: number;
  size?: 'sm' | 'md';
}) {
  const value = Math.max(0, Math.min(100, pct));
  const tone =
    value >= threshold
      ? 'bg-emerald-500'
      : value >= 50
        ? 'bg-amber-500'
        : 'bg-rose-500';
  // Tint the track with a faint version of the tone so a 0% bar still reads
  // as "below threshold, empty" rather than a muted skeleton placeholder.
  const track =
    value >= threshold
      ? 'bg-emerald-100'
      : value >= 50
        ? 'bg-amber-100'
        : 'bg-rose-100';
  const textTone =
    value >= threshold
      ? 'text-emerald-700'
      : value >= 50
        ? 'text-amber-700'
        : 'text-rose-700';
  return (
    <div className="flex items-center gap-2">
      <div
        className={cn(
          'overflow-hidden rounded-full',
          track,
          size === 'sm' ? 'h-1.5 w-24' : 'h-2 w-32',
        )}
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-500', tone)}
          style={{ width: `${value}%` }}
        />
      </div>
      <span
        className={cn(
          'tabular-nums',
          textTone,
          size === 'sm' ? 'w-10 text-[11px]' : 'w-12 text-xs',
        )}
      >
        {value.toFixed(1)}%
      </span>
    </div>
  );
}
