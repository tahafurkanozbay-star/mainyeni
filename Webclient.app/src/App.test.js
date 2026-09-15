import React from 'react';
import { render, waitFor, screen } from '@testing-library/react';
import App from './App';

jest.mock('esri-loader', () => ({
    setDefaultOptions: jest.fn()
}));

jest.mock('./Components/App/MapComponent', () => ({
    MapComponent: () => <div data-testid="map-component">Map</div>
}));

jest.mock('./Components/Common/ExperienceUXLayer', () => ({
    ExperienceUXLayer: () => <div data-testid="experience-layer" />
}));

jest.mock('./Components/Common/Loading', () => ({
    FullScreenLoading: () => <div data-testid="loading">Loading</div>
}));

jest.mock('./Components/Common/Error', () => ({
    FullScreenError: () => <div data-testid="error">Error</div>
}));

jest.mock('./Business/ConfigurationBusiness', () => ({
    ConfigurationBusiness: {
        GetMapConfiguration: jest.fn(() => Promise.resolve({
            isSuccess: true,
            data: { configValue: '{}' }
        })),
        GetConfigServices: jest.fn(() => Promise.resolve({
            isSuccess: true,
            data: []
        }))
    }
}));

jest.mock('./Store/Managers/MapManager', () => ({
    __esModule: true,
    default: {
        SetMapConfiguration: jest.fn(),
        SetConfigurationServices: jest.fn()
    }
}));

jest.mock('./Store/Managers/WindowManager', () => ({
    WindowManager: function WindowManager() {}
}));

jest.mock('./Business/CommonBusiness', () => ({
    CommonBusiness: {
        AddProxyRule: jest.fn(),
        GenerateUrl: jest.fn()
    }
}));

test('boots the map after configuration is available', async () => {
    render(<App />);
    expect(screen.getByTestId('loading')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('map-component')).toBeInTheDocument());
    expect(screen.getByTestId('experience-layer')).toBeInTheDocument();
});
