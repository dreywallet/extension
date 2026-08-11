import React from 'react';
import ReactDOM from 'react-dom/client';
import { setCryptoProvider } from '@drey/core/domain/vault/crypto-provider';
import { createLibsodiumCryptoProvider } from '../../adapters/crypto/libsodium-provider';
import '../../ui/styles/tokens.css';
import { VaultRecoveryApp } from './VaultRecoveryApp';
import './vault-recovery.css';

const root = ReactDOM.createRoot(document.getElementById('root')!);

void createLibsodiumCryptoProvider().then((provider) => {
  setCryptoProvider(provider);
  root.render(
    <React.StrictMode>
      <VaultRecoveryApp />
    </React.StrictMode>,
  );
}).catch(() => {
  root.render(
    <main>
      <h1>Offline Vault Role A recovery</h1>
      <p role="alert">Local cryptography could not start. Recovery remains blocked.</p>
    </main>,
  );
});
