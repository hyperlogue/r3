An HTML artifact is a rendered experience: a prototype, dashboard, interactive explanation, or small tool. Start at its published `index.html` and use its own navigation to reach the other pages.

## Use it before reviewing it

Interact with the page as you would with the finished idea. Try an empty form, change a parameter, follow a link, and look at a narrow layout. The most useful feedback often starts with something you could not understand or complete.

Turn on comment mode when you want to point at an element. Select text when the wording is the issue. r3 records rendered evidence such as the element, text, route, and viewport; it does not pretend that a visual selection is a source-code line.

## Choose the right artifact kind

HTML artifacts present the rendered experience without a file browser or source toggle. Ask the agent to make every review page reachable through the page’s navigation.

If you need to inspect the files themselves, ask for a [files artifact](/docs/files/) instead. That view can switch HTML between rendered and source representations.

## Give the page everything it needs

The agent should build and bundle the page before publishing, including local images, styles, scripts, and companion pages. Each version needs the complete asset set. Relative links keep navigation within the publication.

External network access is blocked by default. A page that assumes it can load fonts, scripts, or data from another service may appear incomplete. Ask the agent to bundle those resources, or review the [preview permissions](/docs/permissions/) before granting access.

## Follow an element through revisions

Stable, descriptive HTML IDs help the agent identify the same control across publications. A reply may include a named fix link such as **Fix: Visibility explanation**. Open it to inspect the published location.

Supported rendered-element fixes can offer **Compare** against the original target. If an element no longer exists or cannot be located, the conversation remains available. Read the original version and the agent’s explanation rather than treating a missing highlight as resolved feedback.

Try the [project-creation walkthrough](/use-cases/prototype/) or the [interactive search explanation](/use-cases/explanation/). Agents preparing HTML can use the [HTML publication guide](/docs/agents/html/).
