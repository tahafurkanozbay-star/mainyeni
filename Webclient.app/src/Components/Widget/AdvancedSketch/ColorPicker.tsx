import {
  useId,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { normalizeHexColor } from './AdvancedSketchRuntime';

export interface ColorPickerValue {
  readonly hex: string;
  readonly alpha: number;
}

export interface ColorPickerProps {
  readonly label: string;
  readonly value: ColorPickerValue;
  readonly onChange: (value: ColorPickerValue) => void;
  readonly disabled?: boolean;
  readonly showAlpha?: boolean;
}

export const ColorPicker = ({
  label,
  value,
  onChange,
  disabled = false,
  showAlpha = false,
}: ColorPickerProps): ReactNode => {
  const colorId = useId();
  const alphaId = useId();
  const [draft, setDraft] = useState(value.hex);

  const commitHex = (candidate: string): void => {
    const normalized = normalizeHexColor(candidate, value.hex);
    setDraft(normalized);
    onChange({ hex: normalized, alpha: value.alpha });
  };

  const onColorChange = (event: ChangeEvent<HTMLInputElement>): void => {
    commitHex(event.target.value);
  };

  const onTextChange = (event: ChangeEvent<HTMLInputElement>): void => {
    setDraft(event.target.value);
  };

  const onTextBlur = (): void => {
    commitHex(draft);
  };

  const onAlphaChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const next = Math.min(1, Math.max(0, Number(event.target.value) / 100));
    onChange({ hex: normalizeHexColor(value.hex), alpha: next });
  };

  return (
    <div className="advanced-sketch-color">
      <label className="advanced-sketch-color__label" htmlFor={colorId}>
        {label}
      </label>
      <div className="advanced-sketch-color__controls">
        <input
          id={colorId}
          className="advanced-sketch-color__native"
          type="color"
          value={normalizeHexColor(value.hex)}
          onChange={onColorChange}
          disabled={disabled}
          aria-label={`${label} renk seçici`}
        />
        <input
          className="advanced-sketch-color__text"
          type="text"
          value={draft}
          onChange={onTextChange}
          onBlur={onTextBlur}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitHex(draft);
            }
          }}
          disabled={disabled}
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={7}
          pattern="#[0-9a-fA-F]{6}"
          aria-label={`${label} onaltılık renk kodu`}
        />
      </div>
      {showAlpha ? (
        <div className="advanced-sketch-color__alpha">
          <label htmlFor={alphaId}>Saydamlık</label>
          <input
            id={alphaId}
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(value.alpha * 100)}
            onChange={onAlphaChange}
            disabled={disabled}
            aria-valuetext={`Yüzde ${Math.round(value.alpha * 100)} görünürlük`}
          />
          <output htmlFor={alphaId}>{Math.round(value.alpha * 100)}%</output>
        </div>
      ) : null}
    </div>
  );
};

export default ColorPicker;
