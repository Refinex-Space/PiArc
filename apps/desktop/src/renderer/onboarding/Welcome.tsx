// The first step of the first-run guide (ADR-0110): the mascot, the name, one line, and the
// two ways on: set a model up now, or later from the new session page or Settings.
import { useT } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { Mascot } from '../shell/Mascot.js';

export function Welcome({
  onStart,
  onLater,
  busy,
}: {
  readonly onStart: () => void;
  readonly onLater: () => void;
  readonly busy: boolean;
}) {
  const t = useT();
  return (
    <section className="onboarding-welcome" aria-labelledby="onboarding-welcome-title">
      <div className="onboarding-welcome-hero">
        <Mascot block={7} testId="onboarding-mascot" className="onboarding-mascot" />
        <h1
          id="onboarding-welcome-title"
          className="onboarding-lede"
          data-testid="onboarding-welcome-title"
          tabIndex={-1}
          data-focus-proxy
        >
          {t('onboarding.welcome.lede')}
        </h1>
      </div>
      <div className="onboarding-welcome-actions">
        <Button
          variant="primary"
          className="onboarding-wide"
          data-testid="onboarding-start"
          disabled={busy}
          onClick={onStart}
        >
          {t('onboarding.welcome.start')}
        </Button>
        <Button
          variant="ghost"
          className="onboarding-later"
          data-testid="onboarding-later"
          loading={busy}
          onClick={onLater}
        >
          {t('onboarding.welcome.later')}
        </Button>
      </div>
    </section>
  );
}
