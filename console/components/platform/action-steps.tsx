import { Check } from 'lucide-react';

/**
 * The one pattern every change on the Skills & MCP screen follows, said once: preview what would be
 * written, apply exactly that, and undo it from the section that keeps the record. Nothing is written
 * at the first step, and the second step applies only the preview that was shown.
 */
export function ActionSteps({ undoWhere }: { undoWhere: string }) {
  return (
    <ol className="action-steps" aria-label="How a change is made here">
      <li>
        <span className="action-step-n" aria-hidden="true">
          1
        </span>
        <strong>Preview</strong>
        <span>Nothing is written.</span>
      </li>
      <li>
        <span className="action-step-n" aria-hidden="true">
          2
        </span>
        <strong>Apply</strong>
        <span>Writes exactly the preview.</span>
      </li>
      <li>
        <span className="action-step-n" aria-hidden="true">
          <Check size={13} />
        </span>
        <strong>Undo</strong>
        <span>{undoWhere}</span>
      </li>
    </ol>
  );
}
