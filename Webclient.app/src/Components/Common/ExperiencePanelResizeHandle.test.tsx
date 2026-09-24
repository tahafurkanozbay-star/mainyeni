import { fireEvent, render, screen } from '@testing-library/react';
import { createPanelLayoutModel } from '../../experience/panelLayoutModel';
import { ExperiencePanelResizeHandle } from './ExperiencePanelResizeHandle';

describe('ExperiencePanelResizeHandle', () => {
  test('exposes bounded separator semantics and updates navigation size from the keyboard', () => {
    const model = createPanelLayoutModel({ viewportWidth: 1440, viewportHeight: 900 });
    render(
      <ExperiencePanelResizeHandle
        model={model}
        panelId="navigation"
        label="Sol panel genişliğini ayarla"
      />,
    );

    const separator = screen.getByRole('separator', {
      name: 'Sol panel genişliğini ayarla',
    });

    expect(separator).toHaveAttribute('aria-orientation', 'vertical');
    expect(separator).toHaveAttribute('aria-valuemin', '260');
    expect(separator).toHaveAttribute('aria-valuemax', '480');
    expect(separator).toHaveAttribute('aria-valuenow', '320');

    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator).toHaveAttribute('aria-valuenow', '336');

    fireEvent.keyDown(separator, { key: 'ArrowRight', shiftKey: true });
    expect(separator).toHaveAttribute('aria-valuenow', '384');

    fireEvent.keyDown(separator, { key: 'Home' });
    expect(separator).toHaveAttribute('aria-valuenow', '260');

    fireEvent.keyDown(separator, { key: 'End' });
    expect(separator).toHaveAttribute('aria-valuenow', '480');

    fireEvent.keyDown(separator, { key: 'Enter' });
    expect(separator).toHaveAttribute('aria-valuenow', '320');
  });

  test('uses panel-aware arrow direction for right and bottom panels', () => {
    const toolsModel = createPanelLayoutModel({ viewportWidth: 1440, viewportHeight: 900 });
    const toolsView = render(
      <ExperiencePanelResizeHandle
        model={toolsModel}
        panelId="tools"
        label="Sağ panel genişliğini ayarla"
      />,
    );

    const tools = screen.getByRole('separator', {
      name: 'Sağ panel genişliğini ayarla',
    });
    fireEvent.keyDown(tools, { key: 'ArrowLeft' });
    expect(tools).toHaveAttribute('aria-valuenow', '376');
    fireEvent.keyDown(tools, { key: 'ArrowRight' });
    expect(tools).toHaveAttribute('aria-valuenow', '360');
    toolsView.unmount();

    const detailsModel = createPanelLayoutModel({ viewportWidth: 1440, viewportHeight: 900 });
    detailsModel.open('details');
    render(
      <ExperiencePanelResizeHandle
        model={detailsModel}
        panelId="details"
        label="Alt panel yüksekliğini ayarla"
      />,
    );

    const details = screen.getByRole('separator', {
      name: 'Alt panel yüksekliğini ayarla',
    });
    expect(details).toHaveAttribute('aria-orientation', 'horizontal');
    fireEvent.keyDown(details, { key: 'ArrowUp' });
    expect(details).toHaveAttribute('aria-valuenow', '336');
    fireEvent.keyDown(details, { key: 'ArrowDown' });
    expect(details).toHaveAttribute('aria-valuenow', '320');
  });

  test('does not render a resize affordance when the panel presentation is not docked', () => {
    const model = createPanelLayoutModel({ viewportWidth: 640, viewportHeight: 900 });
    render(
      <ExperiencePanelResizeHandle
        model={model}
        panelId="navigation"
        label="Sol panel genişliğini ayarla"
      />,
    );

    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  test('clamps custom keyboard steps to the supported bounded range', () => {
    const model = createPanelLayoutModel({ viewportWidth: 1440, viewportHeight: 900 });
    render(
      <ExperiencePanelResizeHandle
        model={model}
        panelId="navigation"
        label="Sol panel genişliğini ayarla"
        stepPx={1}
        largeStepPx={999}
      />,
    );

    const separator = screen.getByRole('separator', {
      name: 'Sol panel genişliğini ayarla',
    });
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator).toHaveAttribute('aria-valuenow', '324');
    fireEvent.keyDown(separator, { key: 'ArrowRight', shiftKey: true });
    expect(separator).toHaveAttribute('aria-valuenow', '452');
  });
});
