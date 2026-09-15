import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import App from './App';

jest.mock('./Business/ConfigurationBusiness', () => ({
  ConfigurationBusiness: {
    GetMapConfiguration: jest.fn(() => Promise.resolve({
      isSuccess: true,
      data: { configValue: '{"Centerx": 32.85, "Centery": 39.93}' },
    })),
    GetConfigServices: jest.fn(() => Promise.resolve({ isSuccess: true, data: [] })),
  },
}));

jest.mock('./Store/Managers/MapManager', () => ({
  __esModule: true,
  default: {
    SetMapConfiguration: jest.fn(),
    SetConfigurationServices: jest.fn(),
  },
}));

jest.mock('./Store/Managers/WindowManager', () => ({
  WindowManager: jest.fn(() => ({})),
}));

jest.mock('./Business/CommonBusiness', () => ({
  CommonBusiness: {
    AddProxyRule: jest.fn(),
    GenerateUrl: jest.fn(),
  },
}));

jest.mock('./Components/App/MapComponent', () => ({
  MapComponent: () => <div data-testid="map-component">Harita</div>,
}));

jest.mock('./Components/Common/ExperienceUXLayer', () => ({
  ExperienceUXLayer: () => <div data-testid="experience-layer">Deneyim araçları</div>,
}));

jest.mock('./Components/Common/Loading', () => ({
  FullScreenLoading: () => <div data-testid="loading">Yükleniyor</div>,
}));

jest.mock('./Components/Common/Error', () => ({
  FullScreenError: () => <div data-testid="error">Hata</div>,
}));

jest.mock('esri-loader', () => ({ setDefaultOptions: jest.fn() }));

test('loads the main map shell after GIS configuration resolves', async () => {
  render(<App />);

  expect(screen.getByTestId('loading')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId('map-component')).toBeInTheDocument());
  expect(screen.getByTestId('experience-layer')).toBeInTheDocument();
  expect(screen.queryByTestId('loading')).not.toBeInTheDocument();
  expect(screen.queryByTestId('error')).not.toBeInTheDocument();
});
