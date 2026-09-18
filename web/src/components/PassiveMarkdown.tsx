import { useLayoutEffect, useMemo, useRef } from "react";
import { MAX_RENDERED_HEIGHT } from "../../../shared/artifacts.ts";
import type { PreviewTheme } from "../../../shared/preview-protocol.ts";
import { passiveMarkdownDocument } from "../passive-markdown.ts";
import { isReadingPosition, readingPositions } from "../reading-position.ts";
import { cn } from "../ui.tsx";

export function PassiveMarkdown(props: {
  html: string;
  theme: PreviewTheme;
  fitContent: boolean;
  height?: number;
  scrollKey: string | null;
  onHeight: (height: number) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const current = useRef(props);
  current.current = props;
  const { html, theme, fitContent, scrollKey } = props;
  const document = useMemo(() => {
    const nonce = crypto.randomUUID();
    try {
      return {
        nonce,
        html: passiveMarkdownDocument(html, {
          nonce,
          applicationOrigin: location.origin,
          theme,
          fitContent,
          position: scrollKey ? readingPositions.get(scrollKey) : undefined,
        }),
      };
    } catch {
      return null;
    }
  }, [html, theme, fitContent, scrollKey]);
  useLayoutEffect(() => {
    if (!document) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      const message = event.data;
      if (message?.type !== "r3-markdown-reading" || message.nonce !== document.nonce) return;
      if (
        Number.isFinite(message.height) &&
        message.height > 0 &&
        message.height <= MAX_RENDERED_HEIGHT
      )
        current.current.onHeight(message.height);
      if (
        !current.current.fitContent &&
        current.current.scrollKey &&
        isReadingPosition(message.point)
      )
        readingPositions.set(current.current.scrollKey, message.point);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [document]);
  if (!document) return null;
  return (
    <iframe
      ref={frame}
      data-markdown-reading
      title="Cached Markdown — preview checks in progress"
      srcDoc={document.html}
      sandbox="allow-scripts"
      {...{ credentialless: "" }}
      allow="camera 'none'; microphone 'none'"
      referrerPolicy="no-referrer"
      style={{ height: props.fitContent ? props.height : undefined }}
      className={cn(
        "w-full border-0 bg-white dark:bg-neutral-950",
        props.fitContent ? "flex-none" : "min-h-80 flex-1",
      )}
    />
  );
}
