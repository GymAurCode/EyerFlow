/**
 * Clipboard writes with a fallback.
 *
 * `navigator.clipboard.writeText` is the right API but it fails in more cases
 * than it should inside a desktop shell: it is missing entirely when the window
 * is not a secure context, and it rejects with "Document is not focused" when
 * the window loses focus between the click and the write. Both happen in
 * practice - a user clicking "Copy machine ID" in a window that is not the
 * active window is not an unusual thing to do.
 *
 * The fallback stages the text in a hidden textarea and runs `execCommand`,
 * which is deprecated in browsers but still the only synchronous copy path
 * Electron offers, and needs no permission of its own.
 */

/** True when the text is worth putting on the clipboard. */
function hasText(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * Copy `text`, resolving when it reached the clipboard.
 *
 * Throws when both paths fail, so the caller can tell the user rather than
 * silently pretending the copy worked.
 */
export async function copyText(text: string): Promise<void> {
  if (!hasText(text)) {
    throw new Error("There is nothing to copy");
  }

  if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the textarea path.
    }
  }

  if (copyViaTextarea(text)) return;

  throw new Error("The clipboard is not available");
}

/** Stage `text` in an off-screen textarea and ask the browser to copy it. */
function copyViaTextarea(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  // Off-screen rather than hidden: a `display: none` element has no layout box
  // and the copy silently does nothing.
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";

  document.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, area.value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
  }
}
