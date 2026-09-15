import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

jest.mock('./Business/ConfigurationBusiness', () => ({
  ConfigurationBusiness: {
    GetMapConfiguration: jest.fn(() => Promise.resolve({ isSuccess: true, data: { configValue: '{}' } })),
    GetConfigServices: jest.fn(() => Promise.resolve({ isSuccess: true, data: [] })),
  },
}));

jest.mock('./Components/App/MapComponent', () => ({ MapComponent: () => <div data-testid="map-component">Harita</div> }));
jest.mock('./Components/Common/ExperienceUXLayer', () => ({ ExperienceUXLayer: () => <div data-testid="experience-layer">Deneyim araçları</div> }));
jest.mock('esri-loader', () => ({ setDefaultOptions: jest.fn() }));

test('loads the main map shell after GIS configuration resolves', async () => {
  render(<App />);
  expect(await screen.findByTestId('map-component')).toBeInTheDocument();
  expect(screen.getByTestId('experience-layer')).toBeInTheDocument();
});
