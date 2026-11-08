/**
 * Initials avatar, with an optional photograph.
 *
 * Products, customers and suppliers have no photographs, and stocking images
 * for them would mean an upload path and a cache directory for something a
 * counter assistant should never have to think about. Two letters from the
 * name in a colour chosen by hashing that name is enough to tell two rows
 * apart at a glance, and it costs nothing. Pass `tone="neutral"` where the chip
 * stands in for a product photo rather than for a person.
 *
 * A person is different: they can choose a picture of themselves, so `src`
 * takes one when there is one and falls back to those same initials when there
 * is not. The fallback is what makes the prop safe everywhere the component is
 * used - the rail, the top bar, a row - without each caller having to know
 * whether this particular account set one.
 *
 * The tints come from the avatar tokens, so an avatar is never a fixed colour
 * that fights the current theme.
 */

import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";

export type AvatarSize = "xs" | "sm" | "md" | "lg";

const SIZE_CLASSES: Record<AvatarSize, string> = {
  xs: "h-6 w-6 text-[10px]",
  sm: "h-7 w-7 text-[11px]",
  md: "h-8 w-8 text-xs",
  lg: "h-10 w-10 text-sm",
};

const TINTS = [
  "var(--avatar-1)",
  "var(--avatar-2)",
  "var(--avatar-3)",
  "var(--avatar-4)",
  "var(--avatar-5)",
  "var(--avatar-6)",
] as const;

/**
 * Up to two letters from a name.
 *
 * Handles the shapes that actually turn up: a single word ("Blue Water"), an
 * initial plus surname ("M. Khan"), and a name that starts with punctuation.
 */
export function initialsOf(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0 && /[\p{L}\p{N}]/u.test(part[0] as string));

  const first = (parts[0] ?? "")[0] ?? "";
  const last = parts.length > 1 ? ((parts[parts.length - 1] ?? "")[0] ?? "") : "";

  const letters = `${first}${last}`.toUpperCase();
  return letters.length > 0 ? letters : (name.trim()[0] ?? "?").toUpperCase();
}

/** A stable tint for a name, so the same row is always the same colour. */
export function tintForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return TINTS[Math.abs(hash) % TINTS.length] as string;
}

export interface AvatarProps {
  readonly name: string;
  readonly size?: AvatarSize | undefined;
  /** Square rather than round, for product rows. */
  readonly square?: boolean | undefined;
  /**
   * `neutral` is a placeholder chip rather than an identity: a product has no
   * photograph, so its thumbnail stays the same quiet surface in every row
   * instead of competing with the name beside it.
   */
  readonly tone?: "auto" | "neutral" | undefined;
  /**
   * A picture, as a data URL. When absent - or when the browser cannot decode
   * it - the initials are drawn instead, so this is an enhancement and never a
   * dependency: an account with no picture still has an avatar.
   */
  readonly src?: string | null | undefined;
  readonly className?: string | undefined;
}

export function Avatar({
  name,
  size = "md",
  square = false,
  tone = "auto",
  src,
  className,
}: AvatarProps): React.JSX.Element {
  const neutral = tone === "neutral";
  const [failed, setFailed] = useState(false);

  // A new picture has to be tried again, or replacing one that failed to decode
  // would leave the initials showing forever.
  useEffect(() => {
    setFailed(false);
  }, [src]);

  const showImage = src !== undefined && src !== null && src.length > 0 && !failed;

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden font-semibold",
        square ? "rounded-lg" : "rounded-full",
        neutral &&
          "border border-[var(--glass-border)] shadow-[inset_0_1px_0_var(--glass-edge-top)]",
        SIZE_CLASSES[size],
        className,
      )}
      // The initials take the foreground token rather than a hardcoded white:
      // the palette is light in the dark theme and dark in the light one, and
      // the pairing is what keeps the initials legible on both.
      style={
        showImage
          ? undefined
          : neutral
            ? {
                backgroundColor: "var(--avatar-neutral-bg)",
                color: "var(--avatar-neutral-fg)",
              }
            : { backgroundColor: tintForName(name), color: "var(--avatar-fg)" }
      }
      title={name}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
          onError={() => {
            setFailed(true);
          }}
        />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}
