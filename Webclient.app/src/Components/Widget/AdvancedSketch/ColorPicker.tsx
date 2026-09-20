import { useId, type ChangeEvent } from 'react';
import { normalizeHexColor } from './sketchStyleRuntime';

export interface ColorPickerChange {
  readonly hex: string;
}

export interface ColorPickerProps {
  readonly value?: string;
  readonly onChange: (color: ColorPickerChange) => void;
  readonly label?: string;
  readonly disabled?: boolean;
}

export const ColorPicker = ({
  value = '#f17013',
  onChange,
  label = 'Renk seç',
  disabled = false,
}: ColorPickerProps) => {
  const id = useId();
  const normalized = normalizeHexColor(value, '#f17013');

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange(Object.freeze({ hex: normalizeHexColor(event.target.value, normalized) }));
  };

  return (
    <label className="advanced-sketch-color-picker" htmlFor={id}>
      <span className="visually-hidden">{label}</span>
      <input
        id={id}
        type="color"
        className="advanced-sketch-color-input"
        value={normalized}
        onChange={handleChange}
        disabled={disabled}
        aria-label={label}
      />
    </label>
  );
};

export default ColorPicker;
