import React from 'react';
import { act, render, screen } from '@testing-library/react';
import App from './App';
import { ConfigurationBusiness } from './Business/ConfigurationBusiness';

jest.mock('./Business/ConfigurationBusiness', () => ({
  ConfigurationBusiness: {
    GetMapConfiguration: jest.fn(),
    GetConfigServices: jest.fn()
  }
}));

jest.mock('./Components/App/MapComponent', () => ({ MapComponent: () => <div data-testid="map-shell" /> }));
jest.mock('./Components/Common/ExperienceUXLayer', () => ({ ExperienceUXLayer: () => <div data-testid="experience-layer" /> }));
jest.mock('./Components/Common/ExperienceCommandCenter', () => ({ ExperienceCommandCenter: () => null }));

jest.mock('./Store/Managers/WindowManager', () => ({
  useWindowManager: () => ({})
}));

jest.mock('esri-loader', () => ({ setDefaultOptions: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
});

test('renders loading until GIS configuration settles, then exposes the configuration error state', async () => {
  let resolveMapConfiguration;
  let resolveConfigServices;

  ConfigurationBusiness.GetMapConfiguration.mockImplementation(() => new Promise(resolve => {
    resolveMapConfiguration = resolve;
  }));
  ConfigurationBusiness.GetConfigServices.mockImplementation(() => new Promise(resolve => {
    resolveConfigServices = resolve;
  }));

  render(<App />);

  expect(screen.getByRole('status')).toBeInTheDocument();
  expect(screen.getByText(/lütfen bekleyin/i)).toBeInTheDocument();
  expect(screen.queryByTestId('map-shell')).not.toBeInTheDocument();

  await act(async () => {
    resolveMapConfiguration({ isSuccess: false });
    resolveConfigServices({ isSuccess: false });
    await Promise.resolve();
  });

  expect(screen.getByText(/harita yapılandırması yüklenemedi/i)).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
