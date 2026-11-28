// The first-run guide's layer (ADR-0110): a full-window surface over the workbench, which the
// shell makes inert meanwhile. It opens by itself on a first run (welcome, then "Connect a
// model"), or on "Connect a model" from Settings and the new session page, where Back closes
// it. It hides, without unmounting, while Settings is open over it (the proxy page), so the
// step and what was typed survive the trip.
import { useEffect, useRef, useState } from 'react';

import { useT } from '../app/app-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { ConnectModel } from './ConnectModel.js';
import { Welcome } from './Welcome.js';

export type OnboardingStep = 'welcome' | 'connect';

export interface OnboardingRequest {
  readonly step: OnboardingStep;
  /** `auto`: a first run; the others open "Connect a model" for a user who chose it. */
  readonly from: 'auto' | 'settings' | 'home';
  /** Gets the focus back when the guide closes. */
  readonly opener: HTMLElement | null;
}

export function Onboarding({
  request,
  hidden,
  onFinish,
  onClose,
}: {
  readonly request: OnboardingRequest;
  readonly hidden: boolean;
  /** The guide is done (finished, skipped or "Set up later"): writes the preference. */
  readonly onFinish: () => Promise<void>;
  /** Closed without finishing (Back from Settings or the new session page). */
  readonly onClose: () => void;
}) {
  const t = useT();
  const [step, setStep] = useState<OnboardingStep>(request.step);
  const [finishing, setFinishing] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The heading takes the focus (no ring on a button nobody chose yet); Tab reaches the start.
    if (step === 'welcome' && !hidden) root.current?.querySelector<HTMLElement>('h1')?.focus();
  }, [step, hidden]);
  const finish = () => {
    if (finishing) return;
    setFinishing(true);
    void onFinish().finally(() => {
      setFinishing(false);
    });
  };
  const back = () => {
    if (request.from === 'auto') setStep('welcome');
    else onClose();
  };
  return (
    <div
      ref={root}
      className="onboarding"
      data-testid="onboarding"
      data-step={step}
      role="dialog"
      aria-modal="true"
      aria-label={t('onboarding.label')}
      hidden={hidden}
      inert={hidden}
      onKeyDown={(event) => {
        if (
          event.key !== 'Escape' ||
          event.defaultPrevented ||
          isImeComposing(event.nativeEvent) ||
          step !== 'connect' ||
          // A dialog or menu inside the guide closes first.
          (event.target instanceof Element &&
            event.target.closest('.scrim, [role="menu"]') !== null)
        )
          return;
        event.preventDefault();
        back();
      }}
    >
      <div className="onboarding-drag" aria-hidden="true" />
      <div className="onboarding-scroll">
        {step === 'welcome' ? (
          <Welcome
            busy={finishing}
            onStart={() => {
              setStep('connect');
            }}
            onLater={finish}
          />
        ) : (
          <ConnectModel
            backLabel={request.from === 'auto' ? 'onboarding.back' : 'onboarding.close'}
            onBack={back}
            onDone={finish}
          />
        )}
      </div>
    </div>
  );
}
