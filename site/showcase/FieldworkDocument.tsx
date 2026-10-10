import { useEffect, useRef, useState } from "react";
import type { ArtifactRenderedPaneProps } from "../../web/src/artifact-page.tsx";

// A site-authored React document, never arbitrary published HTML. Keeping this
// renderer inline also lets the page run inside an opaque r3 HTML artifact.
export function FieldworkDocument(props: ArtifactRenderedPaneProps) {
  const visibility = useRef<HTMLDivElement>(null);
  const [name, setName] = useState("Autumn launch");
  const [access, setAccess] = useState("Workspace");
  const [created, setCreated] = useState(false);
  const revised = props.version.seq > 1;
  useEffect(() => {
    if (props.active === false || !props.jump) return;
    const found = props.jump.locator?.selector === "#visibility";
    if (found) visibility.current?.scrollIntoView({ block: "nearest" });
    props.onLocated?.(found ? "anchored" : "unplaced");
  }, [props.active, props.jump, props.onLocated]);
  const target = () =>
    props.onTarget({
      kind: "rendered",
      versionSeq: props.version.seq,
      path: props.path,
      locator: { selector: "#visibility", label: "Project visibility" },
    });
  return (
    <div className="fieldwork-document">
      <div className="fieldwork-brand">
        <strong>▧ Fieldwork</strong>
        <span>Workspace / Projects</span>
      </div>
      <div className="fieldwork-body">
        <p className="fieldwork-eyebrow">A little room for your next big idea</p>
        <h1>Start something good.</h1>
        <p className="fieldwork-intro">Bring your people, plans, and progress together.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setCreated(true);
          }}
        >
          <label>
            Project name
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setCreated(false);
              }}
              required
            />
          </label>
          <label>
            Project description <span>Optional</span>
            <input defaultValue="A calmer way to plan our next release." />
          </label>
          <div
            ref={visibility}
            id="visibility"
            className={`fieldwork-visibility ${props.jump && props.highlightLocated !== false ? "fieldwork-located" : ""}`}
          >
            <label>
              Visibility
              <select value={access} onChange={(event) => setAccess(event.target.value)}>
                <option>Workspace</option>
                <option>Private</option>
              </select>
            </label>
            {revised && (
              <p className="fieldwork-help">
                {access === "Workspace"
                  ? "Everyone in your workspace can find and open this project."
                  : "Only people you invite can find and open this project."}{" "}
                You can change this later.
              </p>
            )}
            {props.commenting && (
              <button className="fieldwork-anchor" type="button" onClick={target}>
                Comment on visibility
              </button>
            )}
            {!props.commenting &&
              props.targets.map(({ threadId, target: anchor }) =>
                anchor.kind === "rendered" && anchor.locator?.selector === "#visibility" ? (
                  <button
                    key={threadId}
                    type="button"
                    className="fieldwork-pin"
                    aria-label="Open visibility thread"
                    onClick={() => props.onThread(threadId)}
                  >
                    1
                  </button>
                ) : null,
              )}
          </div>
          <button className="fieldwork-create" type="submit">
            Create project <span aria-hidden="true">↗</span>
          </button>
          {created && (
            <p className="fieldwork-help" role="status">
              “{name}” created in this sample. No data leaves this page.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
