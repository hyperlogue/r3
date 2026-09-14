import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactPreviewNetwork } from "../../../shared/artifacts.ts";
import { demo } from "../../demo/artifact-backend.ts";
import { artifactApi } from "../artifact-api.ts";
import { artifactDrafts } from "../artifact-drafts.ts";
import { useArtifactEvents } from "../artifact-hooks.ts";
import { selectedArtifactVersion } from "../artifact-version.ts";
import { ArtifactFeedbackPanel } from "../components/ArtifactFeedbackPanel.tsx";
import { ArtifactHeader } from "../components/ArtifactHeader.tsx";
import { ArtifactLoading } from "../components/ArtifactLoading.tsx";
import { ArtifactPreviewCompatibilityConsent } from "../components/ArtifactPreviewCompatibilityConsent.tsx";
import { ArtifactPreviewNetworkControl } from "../components/ArtifactPreviewNetworkControl.tsx";
import {
  ArtifactPreviewSecurityProvider,
  ArtifactPreviewSecuritySource,
} from "../components/ArtifactPreviewSecurity.tsx";
import { ArtifactThreadPopover } from "../components/ArtifactThreadPopover.tsx";
import { ArtifactThreads } from "../components/ArtifactThreads.tsx";
import { DiffView } from "../components/DiffView.tsx";
import { FileBrowser } from "../components/FileBrowser.tsx";
import { FileCard, type FoldSignal } from "../components/FileCard.tsx";
import { MessageProse } from "../components/Message.tsx";
import { DiffLayoutToggle, PaneToolbar } from "../components/PaneToolbar.tsx";
import { SourceCode } from "../components/SourceCode.tsx";
import { useTheme } from "../hooks.ts";
import type { FeedbackPanelMode } from "../settings.ts";
import { setFeedbackMode, showFeedbackPanel, useDiffLayout, useFeedbackMode } from "../settings.ts";
import { Button, Pill } from "../ui.tsx";
import { useScrollSpy } from "../useScrollSpy.ts";
import { useSyntaxPalette } from "../useSyntaxPalette.ts";
import "../main.css";

// The build aliases all API calls to this same in-memory demo backend.
function resetSamples() {
  demo.reset();
  demo.get("artifact_documents").watching = true;
  demo.addFeedback("artifact_documents", "Could we make the target label easier to scan?", {
    kind: "artifact",
  });
  demo.addFeedback("artifact_documents", "Keep the spacing comfortable when a reply wraps.", {
    kind: "artifact",
  });
  for (const detail of demo.state.artifacts) {
    const next = demo.state.pending[detail.id];
    if (next) {
      detail.versions.push(structuredClone(next.version));
      demo.state.publications[`${detail.id}/${next.version.seq}`] = structuredClone(next);
      delete demo.state.pending[detail.id];
      demo.changed(detail.id);
    }
  }
}
resetSamples();
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const sections = [
  ["feedback", "Feedback & artifact header"],
  ["content", "Files & diffs"],
  ["protection", "Preview protection"],
  ["controls", "Controls & typography"],
] as const;

function Section({ id, children }: { id: (typeof sections)[number][0]; children: ReactNode }) {
  return (
    <section
      id={id}
      className="scroll-mt-4 space-y-4 border-t border-neutral-200 py-8 dark:border-neutral-800"
    >
      <h2 className="text-lg font-semibold">{sections.find(([key]) => key === id)?.[1]}</h2>
      {children}
    </section>
  );
}

function Feedback({ announce }: { announce: (text: string) => void }) {
  const id = "artifact_documents";
  const [commenting, setCommenting] = useState(false);
  const [versionSeq, setVersionSeq] = useState<number | null>(1);
  const mode = useFeedbackMode();
  const collapsed = mode === "hidden";
  const [threadOpen, setThreadOpen] = useState(false);
  const changeMode = (next: FeedbackPanelMode) => {
    setFeedbackMode(next);
    setThreadOpen(false);
  };
  const reopen = () => {
    showFeedbackPanel();
    setThreadOpen(false);
  };
  const { data } = useQuery({ queryKey: ["artifact", id], queryFn: () => artifactApi.detail(id) });
  if (!data) return <p>Loading sample…</p>;
  return (
    <>
      <p className="text-sm text-neutral-500">
        Try changing versions, editing the title, opening the three-dot menu, replying, and
        resolving a thread. Archive and the description are inside the menu. These are sample
        conversations; use r3’s outer comment mode for your UI feedback.
      </p>
      <div className="border border-neutral-300 dark:border-neutral-700">
        <ArtifactHeader
          detail={data}
          version={selectedArtifactVersion(data.versions, versionSeq)}
          selectedVersion={versionSeq}
          onSelectVersion={setVersionSeq}
          onJumpRef={() => announce("Sample file reference selected")}
          feedbackVisible={!collapsed}
          onToggleFeedback={() => (collapsed ? reopen() : changeMode("hidden"))}
          commenting={commenting}
          onToggleCommenting={() => setCommenting(!commenting)}
        />
        <div className="relative flex h-[680px]">
          <div className="relative isolate min-w-0 flex-1">
            <div className="max-w-sm space-y-3 p-5 text-sm text-neutral-500">
              <p>
                The feedback panel has three states: hidden, expanded beside the content, or
                floating over it. Use the navbar button to hide or show it, and its panel control to
                switch modes. Hidden anchors open one conversation at a time. Showing feedback
                restores the last expanded or floating mode. Drag the floating header to move it, or
                its edges to resize it.
              </p>
              <Button
                onClick={() => {
                  changeMode("expanded");
                  artifactDrafts.anchor(id, { kind: "artifact" });
                }}
              >
                Open sample composer
              </Button>
              <Button
                onClick={() => {
                  changeMode("hidden");
                  setThreadOpen(true);
                }}
              >
                Open sample anchor
              </Button>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() =>
                    demo.addFeedback(
                      id,
                      "A new sample thread for reviewing the entrance animation.",
                      { kind: "artifact" },
                    )
                  }
                >
                  Insert sample card
                </Button>
                <Button
                  disabled={!data.feedback.length}
                  onClick={() => {
                    const last = demo.get(id).feedback.at(-1);
                    if (last) void artifactApi.deleteFeedback(last.id);
                  }}
                >
                  Remove sample card
                </Button>
                <Button
                  disabled={data.feedback.length < 2}
                  onClick={() => {
                    const artifact = demo.get(id);
                    const note = artifact.feedback[0];
                    if (!note) return;
                    const now = new Date().toISOString();
                    note.claim = note.claim
                      ? null
                      : {
                          feedbackId: note.id,
                          sessionId: "showcase-agent",
                          claimedAt: now,
                          renewedAt: now,
                          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                        };
                    artifact.working = artifact.feedback.some((item) => item.claim !== null);
                    demo.changed(id);
                  }}
                >
                  Reorder sample cards
                </Button>
              </div>
              <p>
                Use the sample panel to explore spacing and interaction. Real review comments belong
                to this showcase artifact’s own feedback panel.
              </p>
            </div>
          </div>
          <ArtifactFeedbackPanel mode={mode} onModeChange={changeMode}>
            {(controls) => (
              <ArtifactThreads
                detail={data}
                context={{ versionSeq: 1, representation: "source" }}
                onLocate={() =>
                  announce("Sample target selected — review its label and quote in the thread")
                }
                onJumpRef={() => announce("Sample file reference selected")}
                keysActive={false}
                panelControls={controls}
              />
            )}
          </ArtifactFeedbackPanel>
          {collapsed && threadOpen && data.feedback[0] && (
            <div className="pointer-events-none absolute right-2 top-2 bottom-2 flex w-[440px] max-w-[calc(100%-1rem)] flex-col [&>*]:pointer-events-auto">
              <ArtifactThreadPopover
                feedback={data.feedback[0]}
                context={{ versionSeq: 1, representation: "source" }}
                onLocate={() => announce("Sample target selected")}
                onJumpRef={() => announce("Sample file reference selected")}
                onExpand={reopen}
                onClose={() => setThreadOpen(false)}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Content({ kind, announce }: { kind: "files" | "diff"; announce: (text: string) => void }) {
  const id = kind === "files" ? "artifact_documents" : "artifact_code";
  const detail = demo.get(id);
  const [seq, setSeq] = useState<number | null>(1);
  const publication = demo.publication(id, seq ?? 1);
  const paths =
    kind === "files"
      ? publication.files.map((file) => file.path)
      : publication.diff.map((file) => file.path);
  const [viewed, setViewed] = useState(new Set<string>());
  const [active, setActive] = useState<string | null>(paths[0]);
  const [fold, setFold] = useState<FoldSignal | null>(null);
  const pane = useRef<HTMLDivElement>(null);
  const suspended = useRef(false);
  const style = useSyntaxPalette("github");
  const layout = useDiffLayout();
  useScrollSpy({
    paneRef: pane,
    setActivePath: setActive,
    suspended,
    ready: true,
    fileList: paths,
  });
  const toggle = (path: string) =>
    setViewed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const jump = (path: string) => {
    const node = [...(pane.current?.querySelectorAll<HTMLElement>("[data-file]") ?? [])].find(
      (element) => element.dataset.file === path,
    );
    if (node && pane.current)
      pane.current.scrollBy({
        top: node.getBoundingClientRect().top - pane.current.getBoundingClientRect().top,
      });
    setActive(path);
  };
  return (
    <div
      style={style}
      className="flex h-[570px] flex-col border border-neutral-300 dark:border-neutral-700"
    >
      <ArtifactHeader
        detail={detail}
        version={publication.version}
        selectedVersion={seq}
        onSelectVersion={setSeq}
      />
      <div className="flex min-h-0 flex-1">
        <FileBrowser files={paths} viewed={viewed} activePath={active} onSelect={jump} />
        <div className="relative isolate flex min-w-0 flex-1 flex-col">
          <PaneToolbar
            hasFiles
            onJump={(direction) =>
              jump(
                paths[
                  Math.max(0, Math.min(paths.length - 1, paths.indexOf(active ?? "") + direction))
                ],
              )
            }
            onFoldAll={(mode) => setFold({ mode, nonce: (fold?.nonce ?? 0) + 1 })}
            layoutToggle={kind === "diff" ? <DiffLayoutToggle /> : undefined}
          />
          <div ref={pane} className="min-h-0 flex-1 overflow-auto">
            {kind === "files" ? (
              paths.map((path) => (
                <FileCard
                  key={path}
                  path={path}
                  current={active === path}
                  viewed={viewed.has(path)}
                  onToggleViewed={() => toggle(path)}
                  onFileFeedback={() => announce(`Sample whole-file target: ${path}`)}
                  foldSignal={fold}
                >
                  <SourceCode
                    data={publication.sources[path]}
                    path={path}
                    regions={[]}
                    onPickLines={(_, start, end) =>
                      announce(`Sample line target: ${path}:${start}–${end}`)
                    }
                  />
                </FileCard>
              ))
            ) : (
              <DiffView
                rounds={[
                  {
                    seq: publication.version.seq,
                    files: publication.diff,
                  },
                ]}
                currentPath={active}
                layout={layout}
                foldSignal={fold}
                isViewed={(path) => viewed.has(path)}
                toggle={toggle}
                onPickLines={(path, side, start, end) =>
                  announce(`Sample diff target: ${path}, ${side}, ${start}–${end}`)
                }
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Protection() {
  const [warning, setWarning] = useState(false);
  return (
    <>
      <p className="text-sm text-neutral-500">
        Sample statuses below describe fictional previews. Open their details and Permissions
        dialogs to review the copy. They do not change this artifact’s protection or access real
        devices.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {(["blocked", "compatible", "external"] as const).map((network) => (
          <ProtectionSample key={network} initial={network} />
        ))}
        <div className="space-y-3 border border-neutral-300 p-4 dark:border-neutral-700">
          <h3 className="text-sm font-medium">Browser compatibility warning</h3>
          <Button onClick={() => setWarning(true)}>Show sample risk prompt</Button>
        </div>
      </div>
      {warning && (
        <ArtifactPreviewCompatibilityConsent
          onCancel={() => setWarning(false)}
          onContinue={() => setWarning(false)}
        />
      )}
    </>
  );
}

function ProtectionSample({ initial }: { initial: ArtifactPreviewNetwork }) {
  const [network, setNetwork] = useState(initial);
  const [devices, setDevices] = useState({ camera: false, microphone: false });
  const [sharing, setSharing] = useState(false);
  return (
    <div className="space-y-3 border border-neutral-300 p-4 dark:border-neutral-700">
      <h3 className="text-sm font-medium">
        {initial === "blocked"
          ? "Verified network blocking"
          : initial === "compatible"
            ? "Limited network protection"
            : "External connections allowed"}
      </h3>
      <ArtifactPreviewSecurityProvider>
        <ArtifactHeader
          detail={{ ...demo.get("artifact_documents"), kind: "html", title: "Sample preview" }}
        />
        <ArtifactPreviewSecuritySource
          path="index.html"
          network={network}
          verification="ready"
          devices={devices}
          capture={{
            phase: sharing ? "sharing" : "idle",
            camera: sharing && devices.camera,
            microphone: sharing && devices.microphone,
          }}
        >
          <ArtifactPreviewNetworkControl
            network={network}
            verification="ready"
            html
            compatibilityAccepted={network === "compatible"}
            onForgetCompatibility={() => setNetwork("blocked")}
            devices={devices}
            capture={{
              phase: sharing ? "sharing" : "idle",
              camera: sharing && devices.camera,
              microphone: sharing && devices.microphone,
            }}
            onStopSharing={() => setSharing(false)}
            onChange={(next, permissions) => {
              setNetwork(next);
              setDevices(permissions);
              setSharing(false);
            }}
          />
        </ArtifactPreviewSecuritySource>
      </ArtifactPreviewSecurityProvider>
      {network === "external" && (
        <Button
          disabled={!devices.camera && !devices.microphone}
          onClick={() => setSharing(!sharing)}
        >
          Simulate device sharing
        </Button>
      )}
    </div>
  );
}

function Showcase() {
  useArtifactEvents();
  const [dark, toggleTheme] = useTheme();
  const [kind, setKind] = useState<"files" | "diff">("files");
  const [notice, setNotice] = useState("");
  return (
    <main className="min-h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto max-w-[1500px] px-4 py-8 md:px-8">
        <header className="space-y-4 pb-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Pill>UI review</Pill>
              <h1 className="mt-3 text-2xl font-semibold">r3 component showcase</h1>
            </div>
            <Button aria-pressed={dark} onClick={toggleTheme}>
              {dark ? "Switch to light" : "Switch to dark"}
            </Button>
          </div>
          <p className="max-w-3xl text-sm text-neutral-500">
            Current r3 components, ready for polishing. Turn on r3’s comment mode and select any
            element to leave feedback. Sample interactions reset when the page reloads.
          </p>
          <nav
            aria-label="Showcase sections"
            className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-primary-600 dark:text-primary-400"
          >
            {sections.map(([id, title]) => (
              <a key={id} href={`#${id}`} className="hover:underline">
                {title}
              </a>
            ))}
          </nav>
        </header>
        <Section id="feedback">
          <Feedback announce={setNotice} />
        </Section>
        <Section id="content">
          <p className="text-sm text-neutral-500">
            Complete foldable stacks, a collapsing file list with scroll tracking, syntax
            highlighting, viewed marks, version selection, and unified or split diffs.
          </p>
          <div className="flex gap-2">
            {(["files", "diff"] as const).map((value) => (
              <Button
                key={value}
                aria-pressed={kind === value}
                variant={kind === value ? "primary" : "default"}
                onClick={() => setKind(value)}
              >
                {value === "files" ? "Files sample" : "Diff sample"}
              </Button>
            ))}
          </div>
          <Content key={kind} kind={kind} announce={setNotice} />
        </Section>
        <Section id="protection">
          <Protection />
        </Section>
        <Section id="controls">
          <ArtifactLoading
            label="Loading preview…"
            className="border border-neutral-200 dark:border-neutral-800"
          />
          <div className="flex flex-wrap items-center gap-3">
            {(["default", "primary", "ghost", "danger", "success", "success-outline"] as const).map(
              (variant) => (
                <Button
                  key={variant}
                  variant={variant}
                  onClick={() => setNotice(`${variant} sample button clicked`)}
                >
                  {variant}
                </Button>
              ),
            )}
            <Button disabled>Disabled</Button>
            <Pill>Active</Pill>
            <Pill>html</Pill>
          </div>
          <div className="max-w-2xl border border-neutral-300 p-3 dark:border-neutral-700">
            <MessageProse
              source={
                "### Markdown typography\n\nBody text with **emphasis**, *secondary emphasis*, and `inline code`.\n\n- Keep feedback anchored to its original version.\n- Open the latest publication when you are ready.\n\n> A short quotation from the design discussion.\n\n```ts\nconst version = artifact.versions.at(-1);\n```"
              }
              onJumpRef={() => setNotice("Sample reference selected")}
            />
          </div>
        </Section>
      </div>
      {notice && (
        <div
          role="status"
          className="fixed right-4 bottom-4 z-50 flex max-w-lg items-center gap-3 rounded-lg border border-neutral-300 bg-white p-3 text-xs r3-popover dark:border-neutral-700 dark:bg-neutral-900"
        >
          <span>{notice}</span>
          <Button variant="ghost" onClick={() => setNotice("")}>
            Dismiss
          </Button>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <Showcase />
  </QueryClientProvider>,
);
