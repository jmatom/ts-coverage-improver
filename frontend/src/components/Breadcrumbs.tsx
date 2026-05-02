import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface BreadcrumbItem {
  label: React.ReactNode;
  to?: string;
}

/**
 * Small breadcrumb trail used at the top of detail pages.
 * The last item is rendered as plain text (current page); earlier items
 * are React Router links. Pass `to: undefined` to render any item as text.
 */
export function Breadcrumbs({
  items,
  className,
}: {
  items: BreadcrumbItem[];
  className?: string;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn('flex flex-wrap items-center gap-1 text-sm text-muted-foreground', className)}
    >
      <Link
        to="/"
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
      >
        <Home className="h-3.5 w-3.5" />
        <span className="sr-only">Home</span>
      </Link>
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        return (
          <Fragment key={idx}>
            <ChevronRight className="h-3.5 w-3.5 opacity-60" />
            {item.to && !isLast ? (
              <Link
                to={item.to}
                className="rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
              >
                {item.label}
              </Link>
            ) : (
              <span className={cn('px-1.5', isLast && 'font-medium text-foreground')}>
                {item.label}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
