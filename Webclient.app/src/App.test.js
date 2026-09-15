import React from 'react';
import { render, waitFor, screen } from '@testing-library/react';
import App from './App';
import { ConfigurationBusiness } from './Business/ConfigurationBusiness';
import Store from './Store/Store';

jest.mock('esri-loader', () => ({ setDefaultOptions: jest.fn() }));
jest.mock('./Components/App/MapComponent', () => ({ MapComponent: () => <div data-testid="map-component">Map</div> }));
jest.mock('./Components/Common/ExperienceUXLayer', () => ({ ExperienceUXLayer: () => <div data-testid="experience-layer" /> }));
jest.mock('./Components/Common/Loading', () => ({ FullScreenLoading: () => <div data-testid="loading">Loading</div> }));
jest.mock('./Components/Common/Error', () => ({ FullScreenError: () => <div data-testid="error">Error</div> }));
jest.mock('./Business/ConfigurationBusiness', () => ({
  ConfigurationBusiness: {
    GetMapConfiguration: jest.fn(() => Promise.resolve({ isSuccess: true, data: { configValue: '{}' } })),
    GetConfigServices: jest.fn(() => Promise.resolve({ isSuccess: true, data: [] }))
  }
}));
jest.mock('./Store/Store', () => ({
  __esModule: true,
  default: {
    dispatch: jest.fn(),
    getState: jest.fn(() => ({ Common: {}, Map: {} }))
  }
}));
jest.mock('./Store/Managers/WindowManager', () => ({ WindowManager: function WindowManager() {} }));
jest.mock('./Business/CommonBusiness', () => ({ CommonBusiness: { AddProxyRule: jest.fn(), GenerateUrl: jest.fn() } }));

afterEach(() => jest.clearAllMocks());

test('performs the application bootstrap contract', async () => {
  render(<App />);

  expect(screen.getByTestId('loading')).toBeInTheDocument();
  await waitFor(() => expect(ConfigurationBusiness.GetMapConfiguration).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(ConfigurationBusiness.GetConfigServices).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(Store.dispatch).toHaveBeenCalledTimes(2));
  expect(screen.queryByTestId('error')).not.toBeInTheDocument();
});
