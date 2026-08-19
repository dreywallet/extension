import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApprovalApp } from '../../src/entrypoints/approval/ApprovalApp';
import { I18nProvider } from '../../src/ui/i18n';
import '../../src/ui/styles/tokens.css';
import './gallery.css';
import { APPROVAL_GALLERY_SCENARIOS } from './scenarios';

type PortListener = (message: unknown) => void;

let currentScenarioIndex = 1;
let portListener: PortListener | null = null;

function emitCurrentScenario(): void {
  const scenario = APPROVAL_GALLERY_SCENARIOS[currentScenarioIndex];
  if (scenario) portListener?.(scenario.snapshot);
}

const previewPort = {
  postMessage(raw: unknown): void {
    if (raw === null || typeof raw !== 'object' || !('command' in raw)) return;
    const command = String(raw.command);
    if (command === 'snapshot') {
      queueMicrotask(emitCurrentScenario);
      return;
    }
    if (command === 'resolve') {
      const approved = 'approved' in raw && raw.approved === true;
      window.dispatchEvent(new CustomEvent('drey:gallery-action', {
        detail: approved
          ? 'Approval previewed — nothing was signed.'
          : 'Rejection previewed — nothing was sent.',
      }));
      queueMicrotask(emitCurrentScenario);
      return;
    }
    if (command === 'setFee') {
      window.dispatchEvent(new CustomEvent('drey:gallery-action', {
        detail: 'Fee update previewed — no transaction was changed.',
      }));
      queueMicrotask(emitCurrentScenario);
    }
  },
  disconnect(): void {},
  onMessage: {
    addListener(listener: PortListener): void { portListener = listener; },
    removeListener(listener: PortListener): void {
      if (portListener === listener) portListener = null;
    },
  },
  onDisconnect: { addListener(): void {}, removeListener(): void {} },
};

function connectPreviewPort(): chrome.runtime.Port {
  return previewPort as unknown as chrome.runtime.Port;
}

export function ApprovalGallery(): React.ReactElement {
  const [selected, setSelected] = useState(currentScenarioIndex);
  const [status, setStatus] = useState('Safe local preview — no wallet is connected.');

  useEffect(() => {
    const onAction = (event: Event): void => {
      setStatus((event as CustomEvent<string>).detail);
    };
    window.addEventListener('drey:gallery-action', onAction);
    return () => window.removeEventListener('drey:gallery-action', onAction);
  }, []);

  const selectScenario = (index: number): void => {
    currentScenarioIndex = index;
    setSelected(index);
    setStatus('Safe local preview — no wallet is connected.');
    emitCurrentScenario();
  };

  return (
    <div className="galleryShell">
      <aside className="galleryControls">
        <p className="galleryEyebrow">Local design tool</p>
        <h1>Drey approval gallery</h1>
        <p className="galleryIntro">
          Review the real approval screen using synthetic requests. Nothing here can access a wallet, sign, or broadcast.
        </p>
        <nav aria-label="Approval scenarios" className="scenarioList">
          {APPROVAL_GALLERY_SCENARIOS.map((scenario, index) => (
            <button
              aria-current={selected === index ? 'page' : undefined}
              className={selected === index ? 'scenario selected' : 'scenario'}
              key={scenario.id}
              onClick={() => selectScenario(index)}
              type="button"
            >
              <strong>{scenario.label}</strong>
              <span>{scenario.description}</span>
            </button>
          ))}
        </nav>
        <p aria-live="polite" className="galleryStatus">{status}</p>
      </aside>
      <section aria-label="Approval window preview" className="galleryStage">
        <div className="windowChrome">
          <span />
          <span />
          <span />
          <strong>Approval window · 420 × 680</strong>
        </div>
        <div className="approvalViewport">
          <I18nProvider initial="en"><ApprovalApp connect={connectPreviewPort} /></I18nProvider>
        </div>
      </section>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <React.StrictMode><ApprovalGallery /></React.StrictMode>,
  );
}
