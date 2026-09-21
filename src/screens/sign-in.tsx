import { Check, Copy } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { Backdrop } from '@/components/backdrop';
import { Button } from '@/components/button';
import { Headline } from '@/components/headline';
import { BrainpodMark } from '@/components/marks/brainpod';
import { useAuth } from '@/lib/auth';

export function SignInScreen(): ReactElement {
  const { signIn, cancelSignIn, isSigningIn, error, fallbackUrl } = useAuth();
  const reduced = useReducedMotion() === true;
  const [copied, setCopied] = useState(false);

  // A timeout rather than a transition, so the confirmation still clears for
  // anyone who asked for reduced motion.
  useEffect(() => {
    if (!copied) return;

    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyLink = useCallback(async () => {
    if (fallbackUrl === null) return;

    try {
      await navigator.clipboard.writeText(fallbackUrl);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the URL stays selectable on screen.
    }
  }, [fallbackUrl]);

  const phase = isSigningIn ? 'waiting' : error !== null ? 'failed' : 'resting';

  return (
    // Opaque on purpose. The window is transparent over a vibrancy material,
    // and the desktop showing through the dot globe is two backdrops competing
    // rather than depth, so the brand moment paints its own ground.
    <div className="relative isolate h-full w-full overflow-hidden bg-background">
      {/*
        Full bleed, and outside the content column: the site's backdrop spans
        its whole hero section, and confining it to the 56rem column turns the
        dot field's fade into a visible rectangle.
      */}
      <Backdrop />

      {/*
        The top band clears the traffic lights by dropping below them rather
        than indenting past them: the wordmark shares the content column's left
        edge with the headline and the action, and pushing it 78px inboard
        would break the one alignment the three bands have in common. 38px is
        the overlay drag region, plus the original `pt-6` rhythm.
      */}
      <div className="relative z-10 mx-auto flex h-full w-full max-w-4xl flex-col px-5 pt-[calc(38px+1.5rem)] pb-8 sm:px-6">
        <motion.div
          initial={reduced ? false : { opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 320, damping: 34 }}
          className="flex items-center gap-2.5">
          <BrainpodMark size={19} />
          <span className="text-[15px] font-medium tracking-tight">Brainpod</span>
        </motion.div>

        <div className="flex flex-1 items-center justify-center">
          <Headline />
        </div>

        <div className="flex flex-col items-center gap-4">
          {/* `loading` swaps the label for a spinner, so the accessible name has
              to come from `aria-label` rather than the text. */}
          <Button
            variant="brand"
            size="lg"
            title="Sign in with Brainpod"
            aria-label="Sign in with Brainpod"
            loading={isSigningIn}
            onClick={() => void signIn()}
            className="px-5"
          />

          {/* Keyed on the phase so a change of copy reads as a change of state
              rather than a flicker of text. */}
          <motion.div
            key={phase}
            initial={reduced ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className="flex flex-col items-center gap-3">
            {isSigningIn ? (
              <>
                <p className="max-w-[34rem] text-center text-note text-muted-foreground">
                  Waiting for authorization in your browser.
                </p>

                {/* The system browser may never have opened, so the URL itself is
                    the way out rather than a dead end. */}
                {fallbackUrl !== null && (
                  <p
                    data-selectable
                    className="max-w-[34rem] text-center font-mono text-meta break-all text-muted-foreground">
                    {fallbackUrl}
                  </p>
                )}

                <div className="flex items-center gap-1">
                  {fallbackUrl !== null && (
                    <Button
                      variant="ghost"
                      size="xs"
                      title="Copy link"
                      icon={copied ? <Check /> : <Copy />}
                      onClick={() => void copyLink()}
                    />
                  )}

                  <Button
                    variant="ghost"
                    size="xs"
                    title="Cancel"
                    onClick={() => void cancelSignIn()}
                  />
                </div>
              </>
            ) : error !== null ? (
              <>
                <p className="max-w-[34rem] text-center text-note text-destructive">{error}</p>

                <Button
                  variant="outline"
                  size="sm"
                  title="Try again"
                  onClick={() => void signIn()}
                />
              </>
            ) : (
              <p className="max-w-[34rem] text-center text-note text-muted-foreground">
                You’ll be redirected to Brainpod to authorize this device.
              </p>
            )}
          </motion.div>
        </div>
      </div>
    </div>
  );
}
