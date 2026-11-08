/**
 * First-login theme chooser.
 *
 * A fresh installation has a palette stored (Ocean Teal) but nobody has chosen
 * one yet. When the first administrator reaches the dashboard, this offers the
 * shipped packs, lets them look at one on the real application without saving
 * it, and only writes the choice when they press Done.
 *
 * The three rules that keep it honest:
 *   - Preview is a DOM-only change. It never calls `setPalette`, so a preview
 *     that is abandoned - Back, Escape, closing the window - leaves the stored
 *     palette exactly as it was.
 *   - Done writes the palette through the same `setPalette` the Appearance
 *     screen uses, then records that onboarding is finished.
 *   - The flag lives in the settings table, like the palette itself, so it is
 *     shared by every account on this installation rather than reappearing for
 *     each new user.
 */

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Palette } from "lucide-react";
import { toast } from "sonner";
import { THEME_CATALOG, themeDefinition, type ThemeId } from "../../../shared/themes";
import { errorMessage } from "../../lib/api";
import { applyThemeToDocument, useApp, useTheme } from "../../lib/app-context";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { ThemeCard } from "./ThemeCard";

type Step = "choose" | "preview";

export function ThemeOnboarding(): React.JSX.Element | null {
  const { settings, updateSettings } = useApp();
  const { theme, resolvedTheme, palette, setPalette } = useTheme();
  const [closed, setClosed] = useState(false);
  const [step, setStep] = useState<Step>("choose");
  const [selected, setSelected] = useState<ThemeId>(palette);
  const [previewed, setPreviewed] = useState<ThemeId | null>(null);
  const [busy, setBusy] = useState(false);

  // A preview that is abandoned by unmounting - signing out, reloading, the
  // window closing - must not leave the DOM on an unsaved palette. The refs
  // hold the last committed appearance for that cleanup and are deliberately
  // not dependencies: the component is mounted for the whole flow.
  const previewedRef = useRef<ThemeId | null>(null);
  const committedRef = useRef(false);
  // Captured once: the committed appearance cannot change while the chooser
  // is open, because Done sets `committedRef` as soon as `setPalette` returns
  // and Back restores from the live values rather than from this ref.
  const appearanceRef = useRef({ theme, palette });

  useEffect(() => {
    const appearance = appearanceRef.current;
    return () => {
      if (committedRef.current || previewedRef.current === null) return;
      applyThemeToDocument(appearance.theme, appearance.palette);
    };
  }, []);

  // The dialog is only for a signed-in, not-yet-onboarded installation. Once
  // the settings flag or the local close is set it stays out of the way.
  if (closed || settings.themeOnboardingComplete) return null;

  const chosen = themeDefinition(selected);

  /** Put the committed palette back on <html> without touching the store. */
  const restore = (): void => {
    if (previewed === null) return;
    applyThemeToDocument(theme, palette);
    previewedRef.current = null;
    setPreviewed(null);
  };

  const startPreview = (): void => {
    applyThemeToDocument(theme, selected);
    previewedRef.current = selected;
    setPreviewed(selected);
    setStep("preview");
  };

  const back = (): void => {
    restore();
    setStep("choose");
  };

  /**
   * Persist the chosen pack and close the chooser.
   *
   * `chosen === null` is the "keep current theme" path: nothing is written to
   * the palette, only the onboarding flag, so a shop that already likes its
   * colours is not forced to change them.
   */
  const finish = async (next: ThemeId | null): Promise<void> => {
    setBusy(true);
    try {
      if (next !== null) await setPalette(next);
      // The palette call is the point of no return: it has either persisted
      // the new pack or already rolled itself back. Either way the unmount
      // cleanup must not paint the pre-preview palette over the result.
      committedRef.current = true;
      previewedRef.current = null;
      await updateSettings({ themeOnboardingComplete: true });
      setClosed(true);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Close without applying a preview.
   *
   * Escape, the close button and "Keep current" all land here. The close is
   * immediate so the underlying screen is usable at once; recording the flag is
   * a background write that is not worth blocking the click on.
   */
  const dismiss = (): void => {
    restore();
    setStep("choose");
    setClosed(true);
    void updateSettings({ themeOnboardingComplete: true }).catch((error: unknown) => {
      toast.error(errorMessage(error));
    });
  };

  return (
    <>
      <Dialog
        open={step === "choose"}
        onOpenChange={(open) => {
          if (!open) dismiss();
        }}
        title="Choose your theme"
        description="Pick the colours EyerStock uses. You can change this any time in Settings → Appearance."
        size="lg"
        busy={busy}
        footer={
          <>
            <Button variant="ghost" onClick={dismiss} disabled={busy}>
              Keep current
            </Button>
            <Button
              variant="primary"
              onClick={startPreview}
              disabled={busy}
              iconLeft={<Palette className="h-4 w-4" />}
            >
              Preview {chosen.name}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3" role="group" aria-label="Themes">
            {THEME_CATALOG.map((entry) => (
              <ThemeCard
                key={entry.id}
                theme={entry}
                mode={resolvedTheme}
                selected={entry.id === selected}
                onSelect={() => {
                  setSelected(entry.id);
                }}
              />
            ))}
          </div>

          <p className="text-[11.5px] leading-relaxed text-[var(--text-3)]">
            Preview applies the colours to this screen without saving them. Go back to compare
            another pack, or press Done to keep the one you are looking at.
          </p>
        </div>
      </Dialog>

      {/*
        Preview mode deliberately has no scrim: the point is to look at the
        actual dashboard, cards and rail in the candidate colours. The bar is
        the only chrome added, and it sits over the bottom dock.
      */}
      {step === "preview" && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-4 sm:p-6">
          <div
            role="region"
            aria-label="Theme preview"
            aria-live="polite"
            className="glass-float pointer-events-auto flex w-full max-w-xl flex-wrap items-center gap-3 rounded-2xl px-4 py-3"
          >
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
              style={{ background: "var(--brand)", color: "var(--on-brand)" }}
              aria-hidden="true"
            >
              <Palette className="h-4 w-4" />
            </span>

            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-[var(--text)]">
                Previewing {chosen.name}
              </p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--text-3)]">
                Not saved yet. Go back to compare another pack, or press Done to keep this one.
              </p>
            </div>

            <div className="flex shrink-0 gap-2">
              <Button
                variant="secondary"
                onClick={back}
                disabled={busy}
                iconLeft={<ArrowLeft className="h-4 w-4" />}
              >
                Back
              </Button>
              <Button
                variant="primary"
                onClick={() => void finish(selected)}
                loading={busy}
                iconLeft={<Check className="h-4 w-4" />}
              >
                Done
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
