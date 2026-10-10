Published HTML can execute code. r3 separates that document from the trusted workspace and makes broader access a deliberate choice.

## The default preview

Rendered documents run in an opaque browser origin without the application’s credentials. A scoped preview can read the bytes belonging to its publication. External network access is closed by default.

The browser checks preview capabilities before activating the page. If it cannot verify the required protections, r3 asks for compatibility consent before loading an executable document. A compatibility preview retains restrictive headers and the opaque sandbox, but does not claim the same verified network enforcement.

Remembered compatibility consent skips later capability gates until you forget it. Context setup and origin validation still have to succeed.

## Read Markdown while checks run

After normal authentication, previously opened Markdown may be available through a passive reading cache. Its reading frame removes active elements and URLs, and does not activate the authored document while preview admission is unresolved.

The cache is bounded to 64 MiB, removes entries unused for 30 days, and evicts least-recently-opened content when needed. Logout suspends caching and clears cached data. This cache does not grant permanent access to published content or provide an unauthenticated offline workspace.

## Allow external access when needed

Only HTML artifacts can receive the broader external-access grant. Use the artifact’s permissions control after considering why the page needs it. A page with external access may send content, including information exposed through the artifact runtime, to outside services.

Files artifacts do not receive that exception. If an HTML document in a files artifact needs an external dependency, ask the agent to bundle the dependency or publish the appropriate HTML artifact.

External access is not remembered as a permanent artifact setting. Review permissions again when changing the publication or preview context.

## Camera and microphone

An HTML page can request camera or microphone access through r3’s device relay when explicitly permitted. The relay requires external-network mode as well as separate device consent. Browser permission is an additional requirement; allowing a device in r3 does not bypass the browser prompt.

Device access is scoped to the current document. Navigation resets device choices, and switching contexts ends the old capture. Use the visible sharing control to stop it. Device consent does not itself authorize external networking.

The relay is for supported camera/microphone capture, not screen sharing or arbitrary device enumeration. The page may need to adapt to the supported track behavior.

## Return after a suspended tab or server restart

r3 recreates expired preview sessions automatically, preserving your selected publication, document, and navigation. Preview checks run again unless you have remembered compatibility consent. Device capture ends and device permission must be granted again for the new context.

If recovery fails, use the displayed retry action. You do not need a new publication just to renew the preview session.

## What the public demo demonstrates

The static demo uses bundled content and sandboxed previews. It demonstrates review interactions with a scripted agent. It does not run the server’s capability gate or simulate production preview protection.
