export const homeTitle = "See what your agent drafted. Point to what’s next.";
export const homeDescription =
  "Explore UI prototypes, interactive explainers, and design docs from your agent. Click directly on what needs attention, leave anchored notes, and refine the result together.";

export interface Page {
  path: string;
  title: string;
  description: string;
  group: string;
  source?: string;
  guide?: "main" | "html" | "files" | "diff" | "cli" | "keys";
  navigation?: boolean;
  canonicalPath?: string;
}

export const docs: Page[] = [
  {
    path: "/docs/get-started/",
    title: "Get started",
    description:
      "Install the publishing skill, ask your agent to publish, and make your first review.",
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
    group: "Artifact formats",
    source: "html",
  },
  {
    path: "/docs/files/",
    title: "Documents & files",
    description: "Read Markdown, inspect source, and navigate a complete set of files.",
    group: "Artifact formats",
    source: "files",
  },
  {
    path: "/docs/diffs/",
    title: "Code changes",
    description: "Review captured changes with the original lines and context intact.",
    group: "Artifact formats",
    source: "diffs",
  },
  {
    path: "/docs/media/",
    title: "Images, audio & video",
    description: "Review media and point to the pixels or moment that matter.",
    group: "Artifact formats",
    source: "media",
  },
  {
    path: "/docs/feedback/",
    title: "Precise feedback",
    description: "Select a target, explain the change, and send it to your agent.",
    group: "Review tools",
    source: "feedback",
  },
  {
    path: "/docs/revisions/",
    title: "Revisions & resolution",
    description: "Follow replies, inspect linked fixes, and decide when a thread is done.",
    group: "Review tools",
    source: "revisions",
  },
  {
    path: "/docs/navigation/",
    title: "Navigation & mobile",
    description: "Arrange your workspace, move through files, and review on a small screen.",
    group: "Review tools",
    source: "navigation",
  },
  {
    path: "/docs/keyboard/",
    title: "Keyboard shortcuts",
    description: "A few useful keys, with the full map inside the workspace.",
    group: "Review tools",
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
    group: "Settings & help",
    source: "permissions",
  },
  {
    path: "/docs/configuration/",
    title: "Configuration",
    description: "A few settings you may want to change.",
    group: "Settings & help",
    source: "configuration",
  },
  {
    path: "/docs/troubleshooting/",
    title: "Troubleshooting",
    description: "Recover from a missed handoff, missing content, or a blocked preview.",
    group: "Settings & help",
    source: "troubleshooting",
  },
  {
    path: "/docs/agents/",
    title: "Agent workflow",
    description: "Give your agent the built-in guide.",
    group: "Agent reference",
    navigation: false,
    guide: "main",
  },
  {
    path: "/docs/agents/html/",
    title: "Publish HTML",
    description: "Prepare self-contained pages with useful navigation and stable targets.",
    group: "Agent reference",
    navigation: false,
    guide: "html",
  },
  {
    path: "/docs/agents/files/",
    title: "Publish files",
    description: "Capture complete directories, documents, source, and media.",
    group: "Agent reference",
    navigation: false,
    guide: "files",
  },
  {
    path: "/docs/agents/diff/",
    title: "Publish diffs",
    description: "Choose a Git capture mode and preserve native line targets.",
    group: "Agent reference",
    navigation: false,
    guide: "diff",
  },
  {
    path: "/docs/cli/",
    title: "Command reference",
    description: "Find exact syntax in r3’s built-in help.",
    group: "Agent reference",
    navigation: false,
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
export const navigationDocs = docs.filter((page) => page.navigation !== false);
export const groups = [...new Set(navigationDocs.map((page) => page.group))];
export const docsStart: Page = {
  ...docs[0]!,
  path: "/docs/",
  canonicalPath: docs[0]!.path,
};
export const landingPages: Page[] = [
  {
    path: "/",
    title: homeTitle,
    description: homeDescription,
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
    path: "/search/",
    title: "Search the docs",
    description: "Find a workflow, feature, or command. Search runs in your browser.",
    group: "Search",
  },
];
export const pages = [...landingPages, docsStart, ...cases, ...docs];
