import React from 'react';
import ReactDOM from 'react-dom/client';
import '../../ui/styles/tokens.css';
import { UiRoot } from '../../ui/UiRoot';
import { App } from '../popup/App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <UiRoot sender="sidepanel">
      <App surface="sidepanel" />
    </UiRoot>
  </React.StrictMode>,
);
