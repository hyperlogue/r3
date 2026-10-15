<!-- visual: permissions -->

## Choose what a page can access

HTML artifacts can execute scripts in the browser. By default, previews are sandboxed in an opaque origin with zero access to your r3 auth credentials or external network APIs.

If your browser cannot verify the required origin protection, r3 prompts for **compatibility consent**. Once granted, r3 remembers your choice so you aren't interrupted repeatedly.

## Grant only what the task requires

If a prototype genuinely requires third-party API access, it can request **external networking**. Only grant this when you trust the page, as it permits outbound requests. Whenever possible, ask your agent to bundle external fonts, images, or libraries directly into the artifact.

Camera and microphone access require explicit permission prompts from both r3 and your browser. A floating indicator lets you stop media capture at any time.

If a preview times out after leaving a tab asleep, click **Retry** to reload the sandbox without needing a new publication.
