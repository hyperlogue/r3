import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactPreviewNetwork } from "../../../shared/artifacts.ts";
import { demo } from "../../demo/artifact-backend.ts";
import { artifactApi } from "../artifact-api.ts";
import { artifactDrafts } from "../artifact-drafts.ts";
import { useArtifactEvents } from "../artifact-hooks.ts";
import { ArtifactHeader } from "../components/ArtifactHeader.tsx";
import { ArtifactPreviewCompatibilityConsent } from "../components/ArtifactPreviewCompatibilityConsent.tsx";
import { ArtifactPreviewNetworkControl } from "../components/ArtifactPreviewNetworkControl.tsx";
import { ArtifactSummary } from "../components/ArtifactSummary.tsx";
import { ArtifactThreads } from "../components/ArtifactThreads.tsx";
import { ArtifactVersionSelect } from "../components/ArtifactVersionSelect.tsx";
import { DiffView } from "../components/DiffView.tsx";
import { FileBrowser } from "../components/FileBrowser.tsx";
import { FileCard, type FoldSignal } from "../components/FileCard.tsx";
import { DiffLayoutToggle, PaneToolbar } from "../components/PaneToolbar.tsx";
import { SourceCode } from "../components/SourceCode.tsx";
import { useDiffLayout } from "../settings.ts";
import { Button, Pill } from "../ui.tsx";
import { useScrollSpy } from "../useScrollSpy.ts";
import { useSyntaxPalette } from "../useSyntaxPalette.ts";
import "../main.css";

// The build aliases all API calls to this same in-memory demo backend.
function resetSamples() {
  demo.reset();
  for (const detail of demo.state.artifacts) {
    const next = demo.state.pending[detail.id];
    if (next) {
      detail.versions.push(structuredClone(next.version));
      demo.state.publications[`${detail.id}/${next.version.seq}`] = structuredClone(next);
      delete demo.state.pending[detail.id];
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
  const { data } = useQuery({ queryKey: ["artifact", id], queryFn: () => artifactApi.detail(id) });
  if (!data) return <p>Loading sample…</p>;
  return (
    <>
      <p className="text-sm text-neutral-500">
        Try editing the title, opening Archive, replying, resolving a thread, and switching queues.
        These are sample conversations; use r3’s outer comment mode for your UI feedback.
      </p>
      <div className="border border-neutral-300 dark:border-neutral-700">
        <ArtifactHeader
          detail={data}
          onDeleted={() => {
            resetSamples();
            void client.invalidateQueries();
          }}
        />
        <div className="grid min-h-[620px] grid-cols-1 lg:grid-cols-[1fr_420px]">
          <div>
            <ArtifactSummary
              source={data.versions[0].summary}
              versionSeq={1}
              onTarget={(target) => artifactDrafts.anchor(id, target)}
              onJumpRef={() => announce("Sample file reference selected")}
            />
            <div className="space-y-3 p-5 text-sm text-neutral-500">
              <p>
                The panel at the right uses the current feedback UI: Active and Resolved queues,
                native target labels, agent replies, and a local draft composer.
              </p>
              <Button onClick={() => artifactDrafts.anchor(id, { kind: "artifact" })}>
                Open sample composer
              </Button>
              <p>
                Use the sample panel to explore spacing and interaction. Real review comments belong
                to this showcase artifact’s own feedback panel.
              </p>
            </div>
          </div>
          <div className="h-[620px] border-l border-neutral-300 dark:border-neutral-700">
            <ArtifactThreads
              detail={data}
              context={{ versionSeq: 1, representation: "source" }}
              onLocate={() =>
                announce("Sample target selected — review its label and quote in the thread")
              }
              onJumpRef={() => announce("Sample file reference selected")}
              keysActive={false}
            />
          </div>
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
    <div style={style} className="flex h-[570px] border border-neutral-300 dark:border-neutral-700">
      <FileBrowser files={paths} viewed={viewed} activePath={active} onSelect={jump} />
      <div className="flex min-w-0 flex-1 flex-col">
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
          right={
            <ArtifactVersionSelect versions={detail.versions} selected={seq} onChange={setSeq} />
          }
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
                  label: publication.version.label,
                  summary: null,
                  created_at: publication.version.createdAt,
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
        <div className="space-y-3 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
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
    <div className="space-y-3 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
      <h3 className="text-sm font-medium">
        {initial === "blocked"
          ? "Verified network blocking"
          : initial === "compatible"
            ? "Limited network protection"
            : "External connections allowed"}
      </h3>
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
  const [dark, setDark] = useState(false);
  const [kind, setKind] = useState<"files" | "diff">("files");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return (
    <main className="min-h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto max-w-[1500px] px-4 py-8 md:px-8">
        <header className="space-y-4 pb-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Pill>UI review</Pill>
              <h1 className="mt-3 text-2xl font-semibold">r3 component showcase</h1>
            </div>
            <Button aria-pressed={dark} onClick={() => setDark(!dark)}>
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
          <div className="flex flex-wrap items-center gap-3">
            {(["default", "primary", "ghost", "danger", "success"] as const).map((variant) => (
              <Button
                key={variant}
                variant={variant}
                onClick={() => setNotice(`${variant} sample button clicked`)}
              >
                {variant}
              </Button>
            ))}
            <Button disabled>Disabled</Button>
            <Pill>Active</Pill>
            <Pill>html</Pill>
          </div>
          <div className="max-w-2xl border border-neutral-300 dark:border-neutral-700">
            <ArtifactSummary
              source={
                "### Published version summary\n\nBody text with **emphasis**, *secondary emphasis*, and `inline code`.\n\n- Keep feedback anchored to its original version.\n- Open the latest publication when you are ready.\n\n> A short quotation from the design discussion.\n\n```ts\nconst version = artifact.versions.at(-1);\n```"
              }
              versionSeq={2}
              onTarget={() => setNotice("Sample summary target selected")}
              onJumpRef={() => setNotice("Sample reference selected")}
            />
          </div>
        </Section>
      </div>
      {notice && (
        <div
          role="status"
          className="fixed right-4 bottom-4 z-50 flex max-w-lg items-center gap-3 rounded-lg border border-neutral-300 bg-white p-3 text-xs shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
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
