import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InscriptionReview, type InscriptionReviewItem } from '../../src/ui/components/InscriptionReview';
import { I18nProvider } from '../../src/ui/i18n';

const FIRST_TXID = 'a'.repeat(64);
const SECOND_TXID = 'b'.repeat(64);

function item(txid: string, number: number, movement: InscriptionReviewItem['movement']) {
  return {
    inscriptionId: `${txid}i0`,
    number,
    satpoint: `${txid}:0:0`,
    outpoint: { txid, vout: 0 },
    movement,
    coLocationGroup: `group-${number}`,
    qualifiedPartialAuthorization: false,
    preview: { kind: 'placeholder' as const, reason: 'unavailable' as const },
  } satisfies InscriptionReviewItem;
}

afterEach(cleanup);

describe('compact inscription review', () => {
  it('expands a primary-inscription review to the complete sorted item set', () => {
    const primary = item(FIRST_TXID, 1, 'sent');
    const retained = item(SECOND_TXID, 2, 'retained');
    render(
      <I18nProvider initial="en">
        <InscriptionReview
          acknowledgementChecked={false}
          compact={true}
          items={[retained, primary]}
          onAcknowledgementChange={() => undefined}
          primaryInscriptionId={primary.inscriptionId}
        />
      </I18nProvider>,
    );

    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.queryByText('#2')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View all 2' }));
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View all 2' })).not.toBeInTheDocument();
  });

  it('keeps heading references unique when related transaction details are open together', () => {
    const repeated = item(FIRST_TXID, 1, 'retained');
    const { container } = render(
      <I18nProvider initial="en">
        <InscriptionReview acknowledgementChecked={false} items={[repeated]}
          onAcknowledgementChange={() => undefined} />
        <InscriptionReview acknowledgementChecked={false} items={[repeated]}
          onAcknowledgementChange={() => undefined} />
      </I18nProvider>,
    );

    const ids = [...container.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const element of container.querySelectorAll('[aria-labelledby]')) {
      const labelledBy = element.getAttribute('aria-labelledby');
      expect(labelledBy).not.toBeNull();
      expect(document.getElementById(labelledBy!)).not.toBeNull();
    }
  });
});
