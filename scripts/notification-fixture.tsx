// Entry for isolated notification acceptance, never bundled into r3.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Notification, NotificationProvider } from "../web/src/components/Notifications.tsx";
import "../web/src/main.css";

function Fixture() {
  const [success, setSuccess] = useState(false);
  const [warning, setWarning] = useState(false);
  const [failure, setFailure] = useState(false);
  const [mounted, setMounted] = useState(true);
  return (
    <>
      <button id="success" type="button" onClick={() => setSuccess(true)}>
        Notify
      </button>
      <button id="failure" type="button" onClick={() => setFailure(true)}>
        Fail
      </button>
      <button id="warning" type="button" onClick={() => setWarning(true)}>
        Warn
      </button>
      <button id="unmount" type="button" onClick={() => setMounted(false)}>
        Navigate away
      </button>
      <div inert style={{ overflow: "hidden", contain: "paint", height: 1 }}>
        {mounted && success && (
          <Notification title="Agent notified" tone="success" onDismiss={() => setSuccess(false)} />
        )}
        {mounted && warning && (
          <Notification
            title="Review notice"
            message="Finish or discard the current draft before changing its target."
            tone="warning"
            onDismiss={() => setWarning(false)}
          />
        )}
        {mounted && failure && (
          <Notification
            title="Agent notification failed"
            message="Check that the agent session is running."
            tone="error"
            command="r3 discussions fetch artifact_example"
            onDismiss={() => setFailure(false)}
          />
        )}
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NotificationProvider>
      <Fixture />
    </NotificationProvider>
  </StrictMode>,
);
