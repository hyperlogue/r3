export interface Page {
  path: string;
  title: string;
  description: string;
  group: string;
  source?: string;
  guide?: "main" | "html" | "files" | "diff" | "cli" | "keys";
}

export const docs: Page[] = [
  {
    path: "/docs/get-started/",
    title: "Get started",
    description: "Install r3, ask your agent to publish, and make your first review.",
    group: "Start here",
    source: "get-started",
  },
  {
    path: "/docs/review-loop/",
    title: "The review loop",
    description: "From the first publication to a change you are happy with.",
    group: "Start here",
    source: "review-loop",
  },
  {
    path: "/docs/access/",
    title: "Local & remote access",
    description: "Open your local workspace or connect agents to your own server.",
    group: "Start here",
    source: "access",
  },
  {
    path: "/docs/html/",
    title: "Interactive pages",
    description: "Use prototypes, explanations, and tools right inside a review.",
    group: "Review work",
    source: "html",
  },
  {
    path: "/docs/files/",
    title: "Documents & files",
    description: "Read Markdown, inspect source, and navigate a complete set of files.",
    group: "Review work",
    source: "files",
  },
  {
    path: "/docs/diffs/",
    title: "Code changes",
    description: "Review captured changes with the original lines and context intact.",
    group: "Review work",
    source: "diffs",
  },
  {
    path: "/docs/media/",
    title: "Images, audio & video",
    description: "Review media and point to the pixels or moment that matter.",
    group: "Review work",
    source: "media",
  },
  {
    path: "/docs/feedback/",
    title: "Precise feedback",
    description: "Select a target, explain the change, and send it to your agent.",
    group: "Review work",
    source: "feedback",
  },
  {
    path: "/docs/revisions/",
    title: "Revisions & resolution",
    description: "Follow replies, inspect linked fixes, and decide when a thread is done.",
    group: "Review work",
    source: "revisions",
  },
  {
    path: "/docs/navigation/",
    title: "Navigation & mobile",
    description: "Arrange your workspace, move through files, and review on a small screen.",
    group: "Review work",
    source: "navigation",
  },
  {
    path: "/docs/keyboard/",
    title: "Keyboard shortcuts",
    description: "The keyboard map, generated from the product’s current bindings.",
    group: "Review work",
    guide: "keys",
  },
  {
    path: "/docs/library/",
    title: "Search & your library",
    description: "Find a publication, return to a conversation, and manage your work.",
    group: "Manage work",
    source: "library",
  },
  {
    path: "/docs/projects/",
    title: "Projects",
    description: "Group related artifacts explicitly or by their Git remote.",
    group: "Manage work",
    source: "projects",
  },
  {
    path: "/docs/cleanup/",
    title: "Archive, usage & cleanup",
    description: "Put finished work away and choose what to keep.",
    group: "Manage work",
    source: "cleanup",
  },
  {
    path: "/docs/permissions/",
    title: "Preview permissions",
    description: "Understand page isolation, external access, and device permissions.",
    group: "Operate r3",
    source: "permissions",
  },
  {
    path: "/docs/configuration/",
    title: "Configuration",
    description: "Server settings, authentication lifetime, and project grouping.",
    group: "Operate r3",
    source: "configuration",
  },
  {
    path: "/docs/troubleshooting/",
    title: "Troubleshooting",
    description: "Recover from a missed handoff, missing content, or a blocked preview.",
    group: "Operate r3",
    source: "troubleshooting",
  },
  {
    path: "/docs/agents/",
    title: "Agent workflow",
    description: "Publish complete artifacts, receive feedback, and reply with verified fixes.",
    group: "Agent reference",
    guide: "main",
  },
  {
    path: "/docs/agents/html/",
    title: "Publish HTML",
    description: "Prepare self-contained pages with useful navigation and stable targets.",
    group: "Agent reference",
    guide: "html",
  },
  {
    path: "/docs/agents/files/",
    title: "Publish files",
    description: "Capture complete directories, documents, source, and media.",
    group: "Agent reference",
    guide: "files",
  },
  {
    path: "/docs/agents/diff/",
    title: "Publish diffs",
    description: "Choose a Git capture mode and preserve native line targets.",
    group: "Agent reference",
    guide: "diff",
  },
  {
    path: "/docs/cli/",
    title: "Command reference",
    description: "Every command and option, generated from r3’s built-in help.",
    group: "Agent reference",
    guide: "cli",
  },
];

export const stories = [
  {
    slug: "prototype",
    number: "01",
    category: "Interactive UI",
    title: "Make the next step obvious.",
    name: "Refine a project-creation flow",
    description:
      "Try the interface. Point at the confusing control. Review a revision in the same conversation.",
    artifact: "HTML",
    source: "prototype",
  },
  {
    slug: "proposal",
    number: "02",
    category: "Documents",
    title: "Turn a proposal into a decision.",
    name: "Improve an onboarding proposal",
    description: "Discuss the paragraph that needs work, with the supporting files close at hand.",
    artifact: "Files",
    source: "proposal",
  },
  {
    slug: "explanation",
    number: "03",
    category: "Interactive explanation",
    title: "Understand it by trying it.",
    name: "Explore how search works",
    description:
      "Ask your agent for an explanation you can experiment with, then question the details.",
    artifact: "HTML",
    source: "explanation",
  },
  {
    slug: "code-review",
    number: "04",
    category: "Code review",
    title: "Follow the fix to the line.",
    name: "Fix duplicate form submissions",
    description:
      "Review an actual patch, discuss the failure case, and inspect the agent’s next publication.",
    artifact: "Diff",
    source: "code-review",
  },
  {
    slug: "media",
    number: "05",
    category: "Images & video",
    title: "Point to the exact moment.",
    name: "Improve a launch campaign",
    description:
      "Keep a saved frame and region attached to the feedback, even as the asset changes.",
    artifact: "Files",
    source: "media-story",
  },
] as const;

export const cases: Page[] = stories.map((story) => ({
  path: `/use-cases/${story.slug}/`,
  title: story.name,
  description: story.description,
  group: "Example Fieldwork",
  source: story.source,
}));
export const groups = [...new Set(docs.map((page) => page.group))];
export const landingPages: Page[] = [
  {
    path: "/",
    title: "Render. Review. Refine.",
    description:
      "Give your agent something better than another chat message. Review interactive pages, documents, code, and media with precise feedback.",
    group: "Home",
  },
  {
    path: "/use-cases/",
    title: "One project. Five ways to work.",
    description:
      "Follow Example Fieldwork from prototype to launch with five concrete r3 walkthroughs.",
    group: "Use cases",
  },
  {
    path: "/docs/",
    title: "A little context. A better review.",
    description:
      "Learn the review loop, explore every review surface, and connect your coding agent.",
    group: "Documentation",
  },
  {
    path: "/search/",
    title: "Search the docs",
    description: "Find a workflow, feature, or command. Search runs in your browser.",
    group: "Search",
  },
];
export const pages = [...landingPages, ...cases, ...docs];
