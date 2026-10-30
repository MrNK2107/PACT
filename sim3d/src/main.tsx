import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { maybeRunDemo } from './app/demo';
import { installDirector } from './app/director';
import { installOffline } from './app/offline';
import './styles.css';

installDirector();
installOffline();
maybeRunDemo();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
