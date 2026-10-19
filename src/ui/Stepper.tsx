import { STEPS, type StepId, type StepState } from './steps';

const ICON: Record<StepState['status'], string> = { ok: '✓', warn: '⚠', error: '✕', locked: '🔒' };
const WORD: Record<StepState['status'], string> = { ok: 'done', warn: 'has warnings', error: 'has problems', locked: 'locked' };

export function Stepper({ current, states, onGo }: { current: StepId; states: Record<StepId, StepState>; onGo: (s: StepId) => void }) {
  return (
    <nav className="stepper" aria-label="Job steps">
      <ol>
        {STEPS.map((s, i) => {
          const st = states[s.id];
          const locked = st.status === 'locked';
          return (
            <li key={s.id}>
              <button
                className={`step-tab ${st.status} ${current === s.id ? 'current' : ''}`}
                disabled={locked}
                aria-current={current === s.id ? 'step' : undefined}
                title={locked ? st.reason : `${s.label}: ${WORD[st.status]}`}
                onClick={() => onGo(s.id)}
              >
                <span className="step-n">{i + 1}</span>
                <span className="step-label">{s.label}</span>
                {/* a page you're on that's still in progress doesn't need an ✕ yet */}
                {!(current === s.id && st.status === 'error') && <span className="step-icon" aria-hidden>{ICON[st.status]}</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
