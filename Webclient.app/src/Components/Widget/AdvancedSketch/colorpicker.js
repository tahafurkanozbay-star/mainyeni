import React, { useState } from "react";

const DEFAULT_COLOR = "#f17013";

const hexToRgb = hex => {
  const normalized = String(hex || DEFAULT_COLOR).replace("#", "");
  const value = Number.parseInt(normalized, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
    a: 1
  };
};

const ColorPicker = ({ onChange, label = "Renk seç" }) => {
  const [color, setColor] = useState(DEFAULT_COLOR);

  const handleChange = event => {
    const nextColor = event.target.value;
    setColor(nextColor);
    onChange?.({ hex: nextColor, rgb: hexToRgb(nextColor) });
  };

  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
      <span className="visually-hidden">{label}</span>
      <input
        type="color"
        value={color}
        onChange={handleChange}
        aria-label={label}
        style={{ width: "46px", height: "32px", padding: "2px", cursor: "pointer" }}
      />
    </label>
  );
};

export default ColorPicker;
