<!-- visual: permissions -->

## Choose what a page can access

HTML artifacts execute scripts in the browser. Previews run in an opaque sandbox with no access to your r3 auth credentials or external network APIs.

Each artifact has its own browser-local storage, separate from your r3 settings and other artifacts. Reloads and version changes retain it; logging out, deleting the artifact, or clearing browser site data removes it. Pages can save up to 256 KiB across 1,024 keys. If browser storage is unavailable, changes last only for the current workspace visit. Allowing external networking also lets a page send its saved state outside r3.

Disabling workspace login does not disable preview isolation, Host/origin checks, or network and device permission controls.

If your browser cannot verify network blocking, r3 can offer **compatibility consent**. Origin isolation remains mandatory. Once granted, r3 remembers your choice so you are not prompted repeatedly.

## Grant only what the task requires

If a prototype requires third-party API access, it can request **external networking**. Grant this only when you trust the page, as it permits outbound requests. Whenever possible, have your agent bundle fonts, images, and dependencies directly into the artifact.

Camera and microphone access require explicit permission prompts from both r3 and your browser. A persistent indicator lets you stop media capture at any time.

If a preview pauses after a background tab is suspended, click **Retry** to reload the sandbox without publishing a new version.
