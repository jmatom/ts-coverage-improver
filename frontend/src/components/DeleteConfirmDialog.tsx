import { ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * Reusable destructive-confirmation dialog.
 *
 * Centralizes the wrapping behavior that long file paths or repo names
 * need (`break-words` on the description, `break-all` available for the
 * caller's identifier span) so adding a new delete flow doesn't require
 * re-deriving the same overflow fix.
 *
 * Controlled-only: callers own the `open` state and render their own
 * trigger button externally (a Tooltip-wrapped Button calling
 * `setOpen(true)` is the typical pattern). This sidesteps Radix's
 * `asChild` cascade limits when nesting Tooltip + DialogTrigger.
 */
interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /**
   * Main confirmation prose. Inline-mono identifiers should use
   * `className="font-mono break-all"` so deep paths wrap mid-string.
   */
  description: ReactNode;
  /**
   * Optional secondary paragraph rendered below the description (typical
   * use: "the GitHub PR / fork is not deleted").
   */
  secondaryNote?: ReactNode;
  onConfirm: () => void;
  confirming: boolean;
  /** Button label when idle (e.g., "Yes, delete"). */
  confirmLabel: string;
  /** Button label while the confirm action is in flight (e.g., "Deleting…"). */
  confirmingLabel: string;
}

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  secondaryNote,
  onConfirm,
  confirming,
  confirmLabel,
  confirmingLabel,
}: DeleteConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="break-words">
            {description}
          </DialogDescription>
          {secondaryNote && (
            <p className="mt-2 text-sm text-muted-foreground">{secondaryNote}</p>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={confirming}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => onConfirm()}
            disabled={confirming}
          >
            {confirming ? confirmingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
