/**
 * Text with the searched-for substring marked.
 *
 * The mark is a real `<mark>` element, styled from the theme's accent token,
 * so it is both visible and announced as highlighted by assistive technology
 * rather than being a coloured span with no meaning.
 */

import { Fragment } from "react";
import { splitHighlight } from "../../lib/search-highlight";

export function HighlightText({
  text,
  term,
}: {
  readonly text: string;
  readonly term: string;
}): React.JSX.Element {
  const parts = splitHighlight(text, term);

  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={`match-${String(index)}`} className="search-match">
            {part.text}
          </mark>
        ) : (
          <Fragment key={`text-${String(index)}`}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
