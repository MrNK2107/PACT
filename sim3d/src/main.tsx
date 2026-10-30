import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { maybeRunDemo } from './app/demo';
import { installDirector } from './app/director';
import './styles.css';

installDirector();
maybeRunDemo();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
