import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalGallery } from '../../tools/approval-gallery/main';

afterEach(cleanup);

describe('approval gallery', () => {
  it('renders and switches the real approval surface with inert actions', async () => {
    render(<ApprovalGallery />);

    expect(await screen.findByRole('heading', { name: 'Send bitcoin?' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Approval scenarios' })).toBeInTheDocument();
    const summary = screen.getByRole('region', { name: 'Transaction summary' });
    const destinations = screen.getByText('Destinations').parentElement;
    const walletContext = screen.getByRole('region', { name: 'Using' });
    expect(destinations).not.toBeNull();
    expect(within(walletContext).queryByText('Network')).toBeNull();
    expect(within(destinations!).getByText('recipient')).toBeInTheDocument();
    expect(within(destinations!).getByText('your Bitcoin change')).toBeInTheDocument();
    expect(summary.compareDocumentPosition(destinations!) & Node.DOCUMENT_POSITION_FOLLOWING)
      .not.toBe(0);
    expect(destinations!.compareDocumentPosition(walletContext) & Node.DOCUMENT_POSITION_FOLLOWING)
      .not.toBe(0);
    expect(screen.queryByText('All outputs are fixed')).toBeNull();
    expect(screen.queryByText('Fixed')).toBeNull();
    expect(within(summary).getByText(/exact fee for this transaction/iu)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Connect/u }));
    expect(await screen.findByRole('heading', { name: 'Connect this site?' })).toBeInTheDocument();
    expect(screen.getByText(/does not let the site sign messages or spend bitcoin/iu))
      .toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Transaction summary' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Long message/iu }));
    expect(await screen.findByRole('heading', { name: 'Sign this message?' }))
      .toBeInTheDocument();
    expect(screen.getByText(/bc1pcquvhrqv0q68t4m0hfq6tpn006qrskyc7yrqnp2uyrf2emg3wynsdjyk38/iu))
      .toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Message batch/iu }));
    expect(await screen.findByRole('heading', { name: 'Sign 2 messages?' }))
      .toBeInTheDocument();
    expect(screen.getByText('Messages can sign you in or confirm an action. They cannot spend bitcoin.'))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Message 1 of 2' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Message 2 of 2' })).toBeInTheDocument();
    expect(screen.getByText(/Purpose: payment address/iu)).toBeInTheDocument();
    expect(screen.getByText(/Purpose: Ordinals address/iu)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign messages' })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: /Marketplace sale/iu }));
    expect(await screen.findByRole('heading', { name: 'List inscription?' }))
      .toBeInTheDocument();
    const marketplaceSummary = screen.getByRole('region', { name: 'Transaction summary' });
    expect(within(marketplaceSummary).getByText('Guaranteed proceeds')).toBeInTheDocument();
    expect(within(marketplaceSummary).getByText('Fee verified now')).toBeInTheDocument();
    expect(within(marketplaceSummary).getByText(/final fee may change/iu)).toBeInTheDocument();
    expect(within(marketplaceSummary).queryByText('Marketplace fee')).toBeNull();
    expect(within(marketplaceSummary).queryByText('Creator royalty')).toBeNull();
    expect(within(marketplaceSummary).queryByText('Miner fee')).toBeNull();
    expect(screen.getByText('Some outputs can change')).toBeInTheDocument();
    expect(screen.getByText('Fixed')).toBeInTheDocument();
    expect(screen.getByText('Can change')).toBeInTheDocument();
    expect(screen.queryByText('All outputs are fixed')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Fee warning/iu }));
    expect(await screen.findByRole('heading', { name: 'Send bitcoin?' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('high compared with the payment');
    expect(screen.queryByText('All outputs are fixed')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Protected fee block/iu }));
    expect(await screen.findByRole('heading', { name: 'Sign this transaction?' }))
      .toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/protected sats would pay the fee/iu);
    expect(screen.getByTestId('approval-approve')).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: /Advanced PSBT/iu }));
    expect(await screen.findByRole('heading', { name: 'Sign this transaction?' }))
      .toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Advanced request');
    expect(screen.queryByText('All outputs are fixed')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Rejection previewed — nothing was sent.'))
      .toBeInTheDocument();
  });
});
