export function FeedbackPanelRail({
  openCount,
  hasDraft = false,
  pending = false,
  watching = false,
  onShow,
}: {
  openCount: number;
  hasDraft?: boolean;
  pending?: boolean;
  watching?: boolean;
  onShow: () => void;
}) {
  return (
    <button
      type="button"
      aria-label="Show feedback"
      title="Show feedback"
      onClick={onShow}
      className="absolute inset-0 flex w-full cursor-pointer flex-col items-center gap-3 bg-white py-2 text-xs text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:bg-neutral-950 dark:hover:bg-neutral-900 dark:hover:text-neutral-200"
    >
      <span className="[writing-mode:vertical-rl]">FEEDBACK · {openCount}</span>
      {hasDraft && <span title="Unsaved draft">✎</span>}
      {pending && <span title="Feedback waiting to be sent">↥</span>}
      {watching && <span title="Agent listening">●</span>}
    </button>
  );
}
