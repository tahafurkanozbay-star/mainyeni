import React from 'react';
import ReactDOM from 'react-dom';

import App from './App';
import { performanceMonitor } from './platform/performance/performanceMonitor';
import './styles.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Kent Rehberi root element was not found.');
}

performanceMonitor.start();
ReactDOM.render(
  <App />,
  rootElement,
  () => performanceMonitor.markRenderComplete()
);
