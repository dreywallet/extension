import React from 'react';
import ReactDOM from 'react-dom/client';
import '../../ui/styles/tokens.css';
import { UiRoot } from '../../ui/UiRoot';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <UiRoot sender="fullpage">
      <App />
    </UiRoot>
  </React.StrictMode>,
);
