import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

jest.mock('./Business/ConfigurationBusiness', () => ({
  ConfigurationBusiness: {
    GetMapConfiguration: jest.fn(() => new Promise(() => {})),
    GetConfigServices: jest.fn(() => new Promise(() => {}))
  }
}));

jest.mock('./Components/App/MapComponent', () => ({ MapComponent: () => <div data-testid="map-shell" /> }));
jest.mock('./Components/Common/ExperienceUXLayer', () => ({ ExperienceUXLayer: () => <div data-testid="experience-layer" /> }));
jest.mock('./Components/Common/ExperienceCommandCenter', () => ({ ExperienceCommandCenter: () => null }));

jest.mock('./Store/Managers/WindowManager', () => ({ WindowManager: function WindowManager() {} }));

jest.mock('esri-loader', () => ({ setDefaultOptions: jest.fn() }));

test('renders the enterprise loading experience before GIS configuration resolves', () => {
  render(<App />);
  expect(screen.getByRole('status')).toBeInTheDocument();
  expect(screen.getByText(/lütfen bekleyin/i)).toBeInTheDocument();
  expect(screen.queryByTestId('map-shell')).not.toBeInTheDocument();
});
