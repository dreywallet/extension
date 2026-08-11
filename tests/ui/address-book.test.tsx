import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AddressBook } from '../../src/entrypoints/fullpage/AddressBook';
import { installFakeChrome, Providers } from './fake-rpc';

const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};
const ADDRESS = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

afterEach(cleanup);

describe('AddressBook', () => {
  it('loads and adds a vault-bound saved recipient', async () => {
    const calls: unknown[] = [];
    installFakeChrome({
      'addressBook.list': () => ({ ok: true, result: {
        version: 1, network: 'mainnet', saved: [], recent: [],
      } }),
      'addressBook.add': (payload) => {
        calls.push(payload);
        return { ok: true, result: {
          version: 1,
          network: 'mainnet',
          saved: [{ id: '11'.repeat(16), label: 'Alice', address: ADDRESS,
            createdAtMs: 1, updatedAtMs: 1 }],
          recent: [],
        } };
      },
    });
    render(<Providers><AddressBook expectation={EXPECTATION} onBack={() => undefined} /></Providers>);
    expect(await screen.findByText('No saved recipients yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add recipient' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alice' } });
    fireEvent.change(screen.getByLabelText('Bitcoin address'), { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole('button', { name: 'Save recipient' }));
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    expect(calls).toEqual([{ label: 'Alice', address: ADDRESS, ...EXPECTATION }]);
  });

  it('uses an explicit cancelable confirmation before deleting a saved recipient', async () => {
    let removals = 0;
    const book = {
      version: 1, network: 'mainnet', saved: [{ id: '11'.repeat(16), label: 'Alice',
        address: ADDRESS, createdAtMs: 1, updatedAtMs: 1 }], recent: [],
    };
    installFakeChrome({
      'addressBook.list': () => ({ ok: true, result: book }),
      'addressBook.remove': () => {
        removals += 1;
        return { ok: true, result: { ...book, saved: [] } };
      },
    });
    render(<Providers><AddressBook expectation={EXPECTATION} onBack={() => undefined} /></Providers>);
    await screen.findByText('Alice');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(removals).toBe(0);
    const confirmation = screen.getByRole('alert');
    expect(within(confirmation).getByText('Remove Alice?')).toBeInTheDocument();
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Remove Alice?')).not.toBeInTheDocument();
    expect(removals).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('No saved recipients yet.')).toBeInTheDocument();
    expect(removals).toBe(1);
  });

  it('searches saved recipients and promotes a recent address into the add form', async () => {
    const recentAddress = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
    const book = {
      version: 1, network: 'mainnet', saved: [{ id: '11'.repeat(16), label: 'Alice',
        address: ADDRESS, createdAtMs: 1, updatedAtMs: 1 }],
      recent: [{ address: recentAddress, lastUsedAtMs: 2, useCount: 1, lastKind: 'bitcoin' }],
    };
    installFakeChrome({
      'addressBook.list': () => ({ ok: true, result: book }),
    });
    render(<Providers><AddressBook expectation={EXPECTATION} onBack={() => undefined} /></Providers>);
    await screen.findByText('Alice');

    fireEvent.change(screen.getByLabelText('Search saved recipients'), {
      target: { value: 'nobody' },
    });
    expect(screen.getByText('No recipients match your search.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search saved recipients'), { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save as recipient' }));
    expect(screen.getByLabelText('Bitcoin address')).toHaveValue(recentAddress);
    expect(screen.getByLabelText('Name')).toHaveFocus();
  });

  it('copies or starts a send from a saved recipient without changing its address', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const onSend = vi.fn();
    installFakeChrome({
      'addressBook.list': () => ({ ok: true, result: {
        version: 1, network: 'mainnet', saved: [{ id: '11'.repeat(16), label: 'Alice',
          address: ADDRESS, createdAtMs: 1, updatedAtMs: 1 }], recent: [],
      } }),
    });
    render(<Providers><AddressBook expectation={EXPECTATION} onBack={() => undefined}
      onSend={onSend} /></Providers>);
    await screen.findByText('Alice');

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(ADDRESS);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith(ADDRESS);
  });
});
