import { useState } from "react";

// Authored sample content. The shared demo preview owns all annotation behavior.
export function FieldworkDocument({ revised }: { revised: boolean }) {
  const [name, setName] = useState("Autumn launch");
  const [access, setAccess] = useState("Workspace");
  const [created, setCreated] = useState(false);
  return (
    <div className="fieldwork-document">
      <div className="fieldwork-brand">
        <strong>
          <span className="fieldwork-mark" aria-hidden="true">
            F
          </span>{" "}
          Fieldwork
        </strong>
        <span>
          Acme workspace{" "}
          <span className="fieldwork-avatar" aria-hidden="true">
            A
          </span>
        </span>
      </div>
      <div className="fieldwork-body">
        <p className="fieldwork-eyebrow">Your workspace, one project at a time</p>
        <h1>Create a project</h1>
        <p className="fieldwork-intro">Give your next idea a place to take shape.</p>
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
          <div id="visibility" className="fieldwork-visibility">
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
          </div>
          <button
            className="fieldwork-create"
            type="button"
            onClick={(event) => {
              if (event.currentTarget.form?.reportValidity()) setCreated(true);
            }}
          >
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
