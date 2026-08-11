/* global document, window, location, history, Event */
const output = document.querySelector('#output');
const discovery = document.querySelector('#discovery');
let paymentAddress = null;

const M9P_RECEIVED_PSBT = 'cHNidP8BAKYCAAAAAqMG59qVP38rU0zeSJ4ZA2vVOu5iGaYGCKOH35Jqlp5UAAAAAAD/////+S5wT717AnMQC/FCusMPJ6XCiENO3VLAbFA4t7SokcoAAAAAAP3///8CECcAAAAAAAAiUSA7grKyqRhTFdpvgNpfBtBEDYpeFFf6kzh8LZGchuyHhnjmAAAAAAAAFgAU0MSj7wnpl7bpnjl+UY/j5BoRjKEAAAAAAAEBHxAnAAAAAAAAFgAUEREREREREREREREREREREREREREAAQEfYOoAAAAAAAAWABTQxKPvCemXtumeOX5Rj+PkGhGMoQAAAA==';

function provider() {
  if (!window.drey?.isDrey) throw new Error('Drey provider not discovered');
  return window.drey;
}

function display(value) {
  output.textContent = JSON.stringify(value, null, 2);
}

function displayError(error) {
  display({ error: { code: error?.code ?? null, message: String(error?.message ?? error) } });
}

async function providerRequest(method, params) {
  const response = await provider().request(method, params);
  if ('error' in response) {
    const error = new Error(response.error.message);
    error.code = response.error.code;
    error.data = response.error.data;
    throw error;
  }
  return response.result;
}

function detect() {
  const entry = window.btc_providers?.find((candidate) => candidate.id === 'drey');
  discovery.textContent = window.drey?.isDrey && entry?.id === 'drey'
    ? `Drey provider discovered (${window.drey.methods.length} methods)`
    : 'Drey provider unavailable';
}

async function request(operation) {
  switch (operation) {
    case 'connect': {
      const result = await providerRequest('wallet_connect', {
        addresses: ['payment', 'ordinals'], message: 'Connect to the local Drey E2E dapp', network: 'Signet',
        permissions: [
          {
            type: 'account', resourceId: 'active', actions: { read: true },
            dataCategories: ['account', 'addresses', 'balance', 'inscriptions'],
          },
          {
            type: 'wallet', resourceId: 'wallet', actions: { readNetwork: true },
            dataCategories: ['network'],
          },
        ],
      });
      paymentAddress = result.addresses.find((entry) => entry.purpose === 'payment')?.address ?? null;
      return result;
    }
    case 'permissions': return providerRequest('wallet_getCurrentPermissions');
    case 'account': return providerRequest('wallet_getAccount');
    case 'network': return providerRequest('wallet_getNetwork');
    case 'addresses': return providerRequest('getAddresses', { purposes: ['payment', 'ordinals'], message: 'Read addresses' });
    case 'balance': return providerRequest('getBalance');
    case 'sign': {
      if (!paymentAddress) {
        const addresses = await providerRequest('getAddresses', { purposes: ['payment'] });
        paymentAddress = addresses.addresses[0]?.address ?? null;
      }
      return providerRequest('signMessage', {
        address: paymentAddress, message: 'Drey M8T local BIP322 proof', protocol: 'BIP322',
      });
    }
    case 'send': return providerRequest('sendTransfer', {
      recipients: [{ address: 'tb1q053ptqlv0ugz8fcc3njw355rdluk4tqnhf0g0j', amount: 1000 }],
    });
    case 'm9p-safe-transfer': {
      return providerRequest('ord_sendInscriptions', {
        transfers: [{
          address: 'tb1q053ptqlv0ugz8fcc3njw355rdluk4tqnhf0g0j',
          inscriptionId: 'aa7f08676c67bb5cab1871bb34abb66440d7d99db81aadf2c38f9220f82ca5d1i0',
        }],
      });
    }
    case 'm9p-received': {
      if (!paymentAddress) throw new Error('Payment address unavailable');
      return providerRequest('signPsbt', {
        psbt: M9P_RECEIVED_PSBT,
        signInputs: { [paymentAddress]: [1] },
        broadcast: false,
      });
    }
    case 'unknown-marketplace': return providerRequest('signPsbt', {
      psbt: 'cHNidP8BAFICAAAAAaqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqAAAAAAD/////ASBOAAAAAAAAFgAUIiIiIiIiIiIiIiIiIiIiIiIiIiIAAAAAAAEBHxAnAAAAAAAAFgAUEREREREREREREREREREREREREREBAwSDAAAAAAA=',
      signInputs: { tb1qpaymentaddress: [0] },
      broadcast: false,
    });
    case 'disconnect': {
      const result = await providerRequest('wallet_disconnect');
      paymentAddress = null;
      return result;
    }
    default: throw new Error(`Unknown operation: ${operation}`);
  }
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-operation]');
  if (!button) return;
  const operation = button.dataset.operation;
  if (operation === 'reload') { location.reload(); return; }
  if (operation === 'replace-state') {
    history.pushState({}, '', `/?checkpoint=${Date.now()}`);
    window.dispatchEvent(new Event('drey:e2e:same-document'));
    display({ navigated: location.href, providerAvailable: Boolean(window.drey?.isDrey) });
    return;
  }
  output.textContent = `Pending ${operation}…`;
  request(operation).then(display, displayError);
});

window.addEventListener('drey#initialized', detect, { once: true });
detect();
