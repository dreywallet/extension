import React from 'react';
import ReactDOM from 'react-dom/client';
import '../../ui/styles/tokens.css';
import { UiRoot } from '../../ui/UiRoot';
import { ApprovalApp } from './ApprovalApp';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <UiRoot sender="approval"><ApprovalApp /></UiRoot>
  </React.StrictMode>,
);
