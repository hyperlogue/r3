import { type Locale, siteTranslator } from "./i18n.ts";
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

export function getCatalog(locale: Locale = "en") {
  const t = siteTranslator(locale);
  const homeTitleLines = [t("home.hero.titleLine1"), t("home.hero.titleLine2")];
  const homeTitle = homeTitleLines.join(" ");
  const homeDescription = t("common.exploreUiPrototypesInteractiveExplainersAndDesign");

  const docs: Page[] = [
    {
      path: "/docs/get-started/",
      title: t("pages.docsGetStarted.title"),
      description: t("pages.docsGetStarted.description"),
      group: t("navigation.groups.startHere"),
      source: "get-started",
    },
    {
      path: "/docs/review-loop/",
      title: t("pages.docsReviewLoop.title"),
      description: t("pages.docsReviewLoop.description"),
      group: t("navigation.groups.startHere"),
      source: "review-loop",
    },
    {
      path: "/docs/access/",
      title: t("pages.docsAccess.title"),
      description: t("pages.docsAccess.description"),
      group: t("navigation.groups.startHere"),
      source: "access",
    },
    {
      path: "/docs/html/",
      title: t("pages.docsHtml.title"),
      description: t("pages.docsHtml.description"),
      group: t("navigation.groups.artifactFormats"),
      source: "html",
    },
    {
      path: "/docs/files/",
      title: t("pages.docsFiles.title"),
      description: t("pages.docsFiles.description"),
      group: t("navigation.groups.artifactFormats"),
      source: "files",
    },
    {
      path: "/docs/diffs/",
      title: t("pages.docsDiffs.title"),
      description: t("pages.docsDiffs.description"),
      group: t("navigation.groups.artifactFormats"),
      source: "diffs",
    },
    {
      path: "/docs/media/",
      title: t("pages.docsMedia.title"),
      description: t("pages.docsMedia.description"),
      group: t("navigation.groups.artifactFormats"),
      source: "media",
    },
    {
      path: "/docs/feedback/",
      title: t("pages.docsFeedback.title"),
      description: t("pages.docsFeedback.description"),
      group: t("navigation.groups.reviewTools"),
      source: "feedback",
    },
    {
      path: "/docs/revisions/",
      title: t("pages.docsRevisions.title"),
      description: t("pages.docsRevisions.description"),
      group: t("navigation.groups.reviewTools"),
      source: "revisions",
    },
    {
      path: "/docs/navigation/",
      title: t("pages.docsNavigation.title"),
      description: t("pages.docsNavigation.description"),
      group: t("navigation.groups.reviewTools"),
      source: "navigation",
    },
    {
      path: "/docs/keyboard/",
      title: t("pages.docsKeyboard.title"),
      description: t("pages.docsKeyboard.description"),
      group: t("navigation.groups.reviewTools"),
      guide: "keys",
    },
    {
      path: "/docs/library/",
      title: t("pages.docsLibrary.title"),
      description: t("pages.docsLibrary.description"),
      group: t("navigation.groups.manageWork"),
      source: "library",
    },
    {
      path: "/docs/projects/",
      title: t("pages.docsProjects.title"),
      description: t("pages.docsProjects.description"),
      group: t("navigation.groups.manageWork"),
      source: "projects",
    },
    {
      path: "/docs/cleanup/",
      title: t("pages.docsCleanup.title"),
      description: t("pages.docsCleanup.description"),
      group: t("navigation.groups.manageWork"),
      source: "cleanup",
    },
    {
      path: "/docs/permissions/",
      title: t("pages.docsPermissions.title"),
      description: t("pages.docsPermissions.description"),
      group: t("navigation.groups.settingsHelp"),
      source: "permissions",
    },
    {
      path: "/docs/configuration/",
      title: t("pages.docsConfiguration.title"),
      description: t("pages.docsConfiguration.description"),
      group: t("navigation.groups.settingsHelp"),
      source: "configuration",
    },
    {
      path: "/docs/troubleshooting/",
      title: t("pages.docsTroubleshooting.title"),
      description: t("pages.docsTroubleshooting.description"),
      group: t("navigation.groups.settingsHelp"),
      source: "troubleshooting",
    },
    {
      path: "/docs/agents/",
      title: t("pages.docsAgents.title"),
      description: t("pages.docsAgents.description"),
      group: t("navigation.groups.agentReference"),
      navigation: false,
      guide: "main",
    },
    {
      path: "/docs/agents/html/",
      title: t("pages.docsAgentsHtml.title"),
      description: t("pages.docsAgentsHtml.description"),
      group: t("navigation.groups.agentReference"),
      navigation: false,
      guide: "html",
    },
    {
      path: "/docs/agents/files/",
      title: t("pages.docsAgentsFiles.title"),
      description: t("pages.docsAgentsFiles.description"),
      group: t("navigation.groups.agentReference"),
      navigation: false,
      guide: "files",
    },
    {
      path: "/docs/agents/diff/",
      title: t("pages.docsAgentsDiff.title"),
      description: t("pages.docsAgentsDiff.description"),
      group: t("navigation.groups.agentReference"),
      navigation: false,
      guide: "diff",
    },
    {
      path: "/docs/cli/",
      title: t("pages.docsCli.title"),
      description: t("pages.docsCli.description"),
      group: t("navigation.groups.agentReference"),
      navigation: false,
      guide: "cli",
    },
  ];

  const stories = [
    {
      slug: "prototype",
      number: "01",
      category: t("stories.prototype.category"),
      title: t("stories.prototype.title"),
      name: t("stories.prototype.name"),
      description: t("stories.prototype.description"),
      artifact: "HTML",
      source: "prototype",
    },
    {
      slug: "proposal",
      number: "02",
      category: t("stories.proposal.category"),
      title: t("stories.proposal.title"),
      name: t("stories.proposal.name"),
      description: t("stories.proposal.description"),
      artifact: "Files",
      source: "proposal",
    },
    {
      slug: "explanation",
      number: "03",
      category: t("stories.explanation.category"),
      title: t("stories.explanation.title"),
      name: t("stories.explanation.name"),
      description: t("stories.explanation.description"),
      artifact: "HTML",
      source: "explanation",
    },
    {
      slug: "code-review",
      number: "04",
      category: t("stories.codeReview.category"),
      title: t("stories.codeReview.title"),
      name: t("stories.codeReview.name"),
      description: t("stories.codeReview.description"),
      artifact: "Diff",
      source: "code-review",
    },
    {
      slug: "media",
      number: "05",
      category: t("stories.media.category"),
      title: t("stories.media.title"),
      name: t("stories.media.name"),
      description: t("stories.media.description"),
      artifact: "Files",
      source: "media-story",
    },
  ] as const;

  const cases: Page[] = stories.map((story) => ({
    path: `/use-cases/${story.slug}/`,
    title: story.name,
    description: story.description,
    group: "Example Fieldwork",
    source: story.source,
  }));
  const navigationDocs = docs.filter((page) => page.navigation !== false);
  const groups = [...new Set(navigationDocs.map((page) => page.group))];
  const docsStart: Page = {
    ...docs[0]!,
    path: "/docs/",
    canonicalPath: docs[0]!.path,
  };
  const landingPages: Page[] = [
    {
      path: "/",
      title: homeTitle,
      description: homeDescription,
      group: t("navigation.groups.home"),
    },
    {
      path: "/use-cases/",
      title: t("pages.useCases.title"),
      description: t("pages.useCases.description"),
      group: t("navigation.groups.useCases"),
    },
    {
      path: "/search/",
      title: t("pages.search.title"),
      description: t("pages.search.description"),
      group: t("navigation.groups.search"),
    },
  ];
  const pages = [...landingPages, docsStart, ...cases, ...docs];

  return {
    homeTitleLines,
    homeTitle,
    homeDescription,
    docs,
    stories,
    cases,
    navigationDocs,
    groups,
    docsStart,
    landingPages,
    pages,
  };
}
export const {
  homeTitleLines,
  homeTitle,
  homeDescription,
  docs,
  stories,
  cases,
  navigationDocs,
  groups,
  docsStart,
  landingPages,
  pages,
} = getCatalog();
