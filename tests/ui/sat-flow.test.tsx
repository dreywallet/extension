import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SatFlow, parseSatFlowModel } from '../../src/ui/components/SatFlow';
import { I18nProvider } from '../../src/ui/i18n';

afterEach(cleanup);

const ID = `${'a1'.repeat(32)}i0`;
const ID2 = `${'b2'.repeat(32)}i0`;

function details(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    feeSats: '411',
    security: { protectedValueExposedToFees: '0' },
    inputs: [
      { index: 0, valueSats: '10000', ownership: 'wallet' },
      { index: 1, valueSats: '120000', ownership: 'wallet' },
    ],
    outputs: [
      { index: 0, address: 'tb1precipient', valueSats: '10000', ownership: 'external', role: 'recipient', committed: true },
      { index: 1, address: 'tb1qchange', valueSats: '119589', ownership: 'wallet', role: 'payment_change', committed: true },
    ],
    inscriptions: [
      { inscriptionId: ID, number: 1234, inputIndex: 0, outputIndex: 0, movement: 'sent' },
    ],
    ...overrides,
  };
}

function renderFlow(raw: Record<string, unknown>): ReturnType<typeof parseSatFlowModel> {
  const model = parseSatFlowModel(raw);
  if (model !== null) {
    render(<I18nProvider initial="en"><SatFlow model={model} /></I18nProvider>);
  }
  return model;
}

describe('parseSatFlowModel', () => {
  it('accepts a well formed snapshot projection', () => {
    expect(parseSatFlowModel(details())).not.toBeNull();
  });

  it('returns null rather than defaulting a missing fee exposure to zero', () => {
    expect(parseSatFlowModel(details({ security: {} }))).toBeNull();
    expect(parseSatFlowModel(details({ security: { protectedValueExposedToFees: null } }))).toBeNull();
  });

  it('returns null when an output omits its commitment state', () => {
    expect(parseSatFlowModel(details({
      outputs: [{ index: 0, address: null, valueSats: '1', ownership: 'wallet', role: 'recipient' }],
    }))).toBeNull();
  });

  it('rejects non-decimal, signed, and oversized amounts', () => {
    for (const value of ['-1', '1e3', '0x10', ' 1', '01', '9'.repeat(21), '']) {
      expect(parseSatFlowModel(details({ feeSats: value }))).toBeNull();
    }
  });

  it('rejects an inscription index pointing outside the declared arrays', () => {
    expect(parseSatFlowModel(details({
      inscriptions: [{ inscriptionId: ID, number: 1, inputIndex: 9, outputIndex: 0, movement: 'sent' }],
    }))).toBeNull();
    expect(parseSatFlowModel(details({
      inscriptions: [{ inscriptionId: ID, number: 1, inputIndex: 0, outputIndex: 9, movement: 'sent' }],
    }))).toBeNull();
  });

  it('rejects a malformed inscription id, duplicate id, or unknown movement', () => {
    expect(parseSatFlowModel(details({
      inscriptions: [{ inscriptionId: 'nope', number: 1, inputIndex: 0, outputIndex: 0, movement: 'sent' }],
    }))).toBeNull();
    expect(parseSatFlowModel(details({
      inscriptions: [
        { inscriptionId: ID, number: 1, inputIndex: 0, outputIndex: 0, movement: 'sent' },
        { inscriptionId: ID, number: 2, inputIndex: 0, outputIndex: 1, movement: 'sent' },
      ],
    }))).toBeNull();
    expect(parseSatFlowModel(details({
      inscriptions: [{ inscriptionId: ID, number: 1, inputIndex: 0, outputIndex: 0, movement: 'burned' }],
    }))).toBeNull();
  });

  it('rejects an index that disagrees with its position', () => {
    expect(parseSatFlowModel(details({
      inputs: [{ index: 3, valueSats: '1', ownership: 'wallet' }],
    }))).toBeNull();
  });

  it('rejects unknown ownership', () => {
    expect(parseSatFlowModel(details({
      inputs: [{ index: 0, valueSats: '1', ownership: 'mine' }],
    }))).toBeNull();
  });

  it('bounds array sizes so a hostile snapshot cannot force unbounded work', () => {
    const many = Array.from({ length: 65 }, (_, index) => ({
      index, valueSats: '1', ownership: 'wallet',
    }));
    expect(parseSatFlowModel(details({ inputs: many, inscriptions: [] }))).toBeNull();
  });

  it('returns null for a non-object, missing arrays, or an empty transaction', () => {
    expect(parseSatFlowModel(undefined)).toBeNull();
    expect(parseSatFlowModel('nope')).toBeNull();
    expect(parseSatFlowModel([])).toBeNull();
    expect(parseSatFlowModel(details({ inputs: undefined }))).toBeNull();
    expect(parseSatFlowModel(details({ inputs: [], inscriptions: [] }))).toBeNull();
  });
});

describe('SatFlow rendering', () => {
  it('draws the diagram and states movement in text', () => {
    renderFlow(details());
    expect(screen.getByRole('heading', { name: 'Sat flow' })).toBeInTheDocument();
    expect(screen.getByLabelText('From')).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toBeInTheDocument();
    // The identifier appears at both ends of the proven path; the movement tag
    // appears only on the destination.
    expect(screen.getAllByText('#1234')).toHaveLength(2);
    expect(screen.getAllByText('Sent')).toHaveLength(1);
    expect(within(screen.getByLabelText('To')).getByText('Sent')).toBeInTheDocument();
    expect(screen.getByText('Leaving your wallet: 1')).toBeInTheDocument();
  });

  it('never renders an address anywhere in the diagram, so no truncated address can be mistaken for the real one', () => {
    const model = renderFlow(details());
    // Structural: the model has no field able to carry an address at all.
    expect(model?.outputs.every((output) => !('address' in output))).toBe(true);
    expect(within(screen.getByLabelText('To')).queryByText(/tb1/u)).toBeNull();
    expect(within(screen.getByLabelText('From')).queryByText(/tb1/u)).toBeNull();
    expect(screen.queryByText(/tb1precipient/u)).toBeNull();
  });

  it('keeps the summary but drops the picture when the shape exceeds the node cap', () => {
    renderFlow(details({
      inputs: Array.from({ length: 5 }, (_, index) => ({
        index, valueSats: '10000', ownership: 'wallet',
      })),
      inscriptions: [],
    }));
    expect(screen.queryByLabelText('From')).toBeNull();
    expect(screen.getByText('No inscriptions are involved.')).toBeInTheDocument();
    expect(screen.getByText(/Inputs: 5/u)).toBeInTheDocument();
    expect(screen.getByText(/Miner fee: 411 sats/u)).toBeInTheDocument();
  });

  it('raises a loss-risk alert when protected sats would be spent as fee', () => {
    renderFlow(details({ security: { protectedValueExposedToFees: '6000' } }));
    expect(screen.getByRole('alert')).toHaveTextContent('Protected sats spent as miner fee: 6,000');
  });

  it('raises a caution when the signature does not commit to every output', () => {
    renderFlow(details({
      outputs: [
        { index: 0, address: null, valueSats: '10000', ownership: 'external', role: 'recipient', committed: true },
        { index: 1, address: null, valueSats: '5000', ownership: 'unproven', role: 'unknown', committed: false },
      ],
    }));
    expect(screen.getByRole('alert')).toHaveTextContent('Outputs that can still change: 1');
    expect(screen.getAllByText('Can change').length).toBeGreaterThan(0);
  });

  it('groups co-located inscriptions into one node rather than inventing a lead number', () => {
    renderFlow(details({
      inscriptions: [
        { inscriptionId: ID, number: 1234, inputIndex: 0, outputIndex: 0, movement: 'sent' },
        { inscriptionId: ID2, number: 1235, inputIndex: 0, outputIndex: 0, movement: 'sent' },
      ],
    }));
    expect(screen.getAllByText('2 together').length).toBeGreaterThan(0);
    expect(screen.queryByText('#1234')).toBeNull();
  });

  it('marks the edge layer decorative so the facts are read from text only once', () => {
    const { container } = render(
      <I18nProvider initial="en"><SatFlow model={parseSatFlowModel(details())!} /></I18nProvider>,
    );
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    // Inert geometry only: no text, no image, no external reference.
    expect(svg?.querySelector('text')).toBeNull();
    expect(svg?.querySelector('image')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    for (const path of svg?.querySelectorAll('path') ?? []) {
      expect(path.getAttribute('d')).toMatch(/^M[-\d. C]+$/u);
    }
  });
});
