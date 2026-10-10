import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RestoreFlow } from '../../src/entrypoints/onboarding/RestoreFlow';
import { installFakeChrome, Providers } from './fake-rpc';

afterEach(cleanup);

const FULL_24 =
  'pitch food above path indicate infant ride bacon neither stable raise hobby tonight tomorrow human limb wait cigar now second trophy one canvas zone';

function setup(): void {
  installFakeChrome({});
  render(
    <Providers>
      <RestoreFlow onDone={() => undefined} onBack={() => undefined} />
    </Providers>,
  );
}

describe('RestoreFlow phrase paste', () => {
  it('selects the complete supported phrase length instead of truncating a valid prefix', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Word 1'), { target: { value: FULL_24 } });

    expect(screen.getByRole('radio', { name: '24 words' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Word 24')).toHaveValue('zone');
    expect(screen.getAllByLabelText(/^Word \d+$/u)).toHaveLength(24);
  });

  it('rejects an unsupported overflowing paste without changing the phrase', () => {
    setup();
    const unsupported = FULL_24.split(' ').slice(0, 13).join(' ');
    fireEvent.change(screen.getByLabelText('Word 1'), { target: { value: unsupported } });

    expect(screen.getByRole('alert')).toHaveTextContent(/not valid/iu);
    expect(screen.getByLabelText('Word 1')).toHaveValue('');
    expect(screen.queryByLabelText('Word 13')).toBeNull();
  });

  it('reads a numbered, one-word-per-line paste straight from the clipboard', () => {
    setup();
    const numbered = FULL_24.split(' ').map((word, index) => `${index + 1}. ${word}`).join('\n');
    fireEvent.paste(screen.getByLabelText('Word 1'), {
      clipboardData: { getData: () => numbered },
    });
    expect(screen.getByRole('radio', { name: '24 words' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Word 1')).toHaveValue('pitch');
    expect(screen.getByLabelText('Word 24')).toHaveValue('zone');
  });

  it('completes an abbreviated word and only flags a word once the box is left', () => {
    setup();
    const first = screen.getByLabelText('Word 1');
    fireEvent.change(first, { target: { value: 'aban' } });
    expect(screen.queryByText('Not a valid recovery word.')).not.toBeInTheDocument();
    fireEvent.blur(first);
    expect(first).toHaveValue('abandon');

    const second = screen.getByLabelText('Word 2');
    fireEvent.change(second, { target: { value: 'abs' } });
    expect(screen.queryByText('Not a valid recovery word.')).not.toBeInTheDocument();
    fireEvent.blur(second);
    expect(second).toHaveValue('abs'); // ambiguous: absent, absorb, abstract…
    expect(screen.getByText('Not a valid recovery word.')).toBeInTheDocument();

    // Text that can never become a word is flagged while typing.
    const third = screen.getByLabelText('Word 3');
    fireEvent.change(third, { target: { value: 'qqq' } });
    expect(screen.getAllByText('Not a valid recovery word.')).toHaveLength(2);
  });

  it('supports arrow-key navigation for phrase length choices', () => {
    setup();
    const twelve = screen.getByRole('radio', { name: '12 words' });
    fireEvent.keyDown(twelve, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: '15 words' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '15 words' })).toHaveFocus();
  });

  it('keeps entry masked until explicitly shown and can mask it again', () => {
    setup();
    expect(screen.getByLabelText('Word 1')).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Show words' }));
    expect(screen.getByLabelText('Word 1')).toHaveAttribute('type', 'text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide words' }));
    expect(screen.getByLabelText('Word 1')).toHaveAttribute('type', 'password');
  });

  it('masks the optional passphrase unless the user explicitly shows it', () => {
    setup();
    fireEvent.click(screen.getByText('BIP39 passphrase (advanced, optional)'));
    const passphrase = screen.getByLabelText('Passphrase');
    expect(passphrase).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show passphrase' }));
    expect(passphrase).toHaveAttribute('type', 'text');
    expect(screen.getByRole('checkbox', { name: 'Hide passphrase' })).toBeChecked();
  });

  it('does not invite an incomplete password submission after a valid phrase', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Word 1'), { target: { value: FULL_24 } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();
    expect(screen.getByText(/at least 12 characters/iu)).toBeVisible();
    fireEvent.change(screen.getByLabelText('App password'), {
      target: { value: 'a-long-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm app password'), {
      target: { value: 'a-long-password' },
    });
    expect(continueButton).toBeEnabled();
  });

  it('asks only for the wallet name when restoring into an unlocked profile', () => {
    installFakeChrome({});
    render(
      <Providers>
        <RestoreFlow existingProfile defaultWalletName="Wallet 2"
          onDone={() => undefined} onBack={() => undefined} />
      </Providers>,
    );
    fireEvent.change(screen.getByLabelText('Word 1'), { target: { value: FULL_24 } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByRole('heading', { name: 'Name this wallet' })).toBeInTheDocument();
    expect(screen.getByLabelText('Wallet name')).toHaveValue('Wallet 2');
    expect(screen.queryByLabelText('App password')).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });
});
