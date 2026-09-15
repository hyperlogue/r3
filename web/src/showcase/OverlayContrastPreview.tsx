export function OverlayContrastPreview() {
  return (
    <div className="grid items-center gap-5 text-sm md:grid-cols-2">
      <div className="space-y-3">
        <h2 className="font-medium">Overlay contrast</h2>
        <p className="text-neutral-500">
          Menus, floating panels, and dialogs use stronger borders, edge lighting, and layered
          shadows. Try floating the feedback panel or opening a menu below in either theme.
        </p>
      </div>
      <div className="grid min-h-44 place-items-center border border-neutral-200 bg-neutral-50 p-6 dark:border-neutral-800 dark:bg-neutral-900">
        <section
          aria-label="Overlay sample"
          className="r3-popover w-full max-w-xs rounded-lg border bg-white p-4 dark:bg-neutral-950"
        >
          <h3 className="font-medium">Sample overlay</h3>
          <p className="mt-2 text-neutral-500">
            The border and shadow separate this surface from the page behind it.
          </p>
        </section>
      </div>
    </div>
  );
}
