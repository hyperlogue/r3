import { Fragment, type ReactNode } from "react";
import { t, useLocale } from "./i18n.ts";

// Named slots keep inline controls and emphasis movable in translated sentences.
// Values remain React nodes: catalogs cannot introduce markup or event handlers.
export function Trans({ message, values }: { message: string; values: Record<string, ReactNode> }) {
  useLocale();
  return t(message)
    .split(/(\{\w+\})/g)
    .map((part, index) => (
      // The message's fixed token positions are stable across ordinary rerenders.
      <Fragment key={index}>
        {/^\{\w+\}$/.test(part) && Object.hasOwn(values, part.slice(1, -1))
          ? values[part.slice(1, -1)]
          : part}
      </Fragment>
    ));
}
