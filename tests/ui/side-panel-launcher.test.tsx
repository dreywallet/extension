import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OpenSidePanelButton,
  openSidePanel,
  sidePanelOpeningSupported,
} from '../../src/entrypoints/popup/OpenSidePanelButton';
import { installFakeChrome, Providers } from './fake-rpc';

afterEach(cleanup);

function installSidePanelChrome(options: {
  window?: chrome.windows.Window;
  open?: () => Promise<void>;
} = {}): void {
  installFakeChrome({});
  Object.assign(chrome, {
    windows: {
      getCurrent: vi.fn(async () => options.window ?? { id: 9, type: 'normal' }),
    },
    sidePanel: {
      open: vi.fn(options.open ?? (async () => undefined)),
    },
  });
}

describe('side panel launcher', () => {
  it('opens the global panel in the current normal browser window', async () => {
    installSidePanelChrome();
    await openSidePanel();
    expect(chrome.windows.getCurrent).toHaveBeenCalledOnce();
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 9 });
  });

  it('reports an inline localized error when Chrome rejects the open request', async () => {
    installSidePanelChrome({ open: async () => { throw new Error('rejected'); } });
    const onErrorChange = vi.fn();
    render(
      <Providers>
        <OpenSidePanelButton onErrorChange={onErrorChange} />
      </Providers>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Open in side panel' }));
    await waitFor(() => expect(onErrorChange).toHaveBeenLastCalledWith(
      'The side panel could not be opened. Try again from a normal browser window.',
    ));
  });

  it('hides the control when the browser does not expose sidePanel.open', () => {
    installFakeChrome({});
    expect(sidePanelOpeningSupported()).toBe(false);
    const { container } = render(
      <Providers>
        <OpenSidePanelButton />
      </Providers>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('rejects non-normal windows before asking Chrome to open a panel', async () => {
    installSidePanelChrome({ window: { id: 4, type: 'popup' } as chrome.windows.Window });
    await expect(openSidePanel()).rejects.toThrow('normal browser window');
    expect(chrome.sidePanel.open).not.toHaveBeenCalled();
  });
});
