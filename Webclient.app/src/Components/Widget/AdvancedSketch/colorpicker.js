import React from "react";

const clampChannel = value => Math.max(0, Math.min(255, Number(value) || 0));
const clampAlpha = value => Math.max(0, Math.min(1, Number(value) || 0));
const toHexChannel = value => Math.round(clampChannel(value)).toString(16).padStart(2, "0");
const rgbToHex = color => `#${toHexChannel(color.r)}${toHexChannel(color.g)}${toHexChannel(color.b)}`;
const hexToRgb = value => {
  const normalized = String(value || "").replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
};

const styles = {
  swatch: {
    padding: "5px",
    background: "#fff",
    border: "1px solid rgba(0,0,0,.1)",
    borderRadius: "2px",
    display: "inline-block",
    cursor: "pointer",
  },
  color: {
    width: "36px",
    height: "14px",
    borderRadius: "2px",
  },
  popover: {
    position: "absolute",
    zIndex: 2,
    padding: "10px",
    background: "#fff",
    border: "1px solid rgba(0,0,0,.15)",
    borderRadius: "4px",
    boxShadow: "0 4px 16px rgba(0,0,0,.18)",
  },
  cover: {
    position: "fixed",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  controls: {
    position: "relative",
    zIndex: 1,
    display: "grid",
    gap: "8px",
    minWidth: "180px",
  },
  alpha: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: "8px",
    alignItems: "center",
  },
};

class ColorPicker extends React.Component {
  state = {
    displayColorPicker: false,
    color: {
      r: 241,
      g: 112,
      b: 19,
      a: 1,
    },
  };

  handleClick = () => {
    this.setState(current => ({ displayColorPicker: !current.displayColorPicker }));
  };

  handleClose = () => {
    this.setState({ displayColorPicker: false });
  };

  emitChange = color => {
    this.props.onChange?.({
      hex: rgbToHex(color),
      rgb: { ...color },
    });
  };

  handleColorChange = event => {
    const rgb = hexToRgb(event.target.value);
    if (!rgb) return;
    this.setState(current => {
      const color = { ...current.color, ...rgb };
      this.emitChange(color);
      return { color };
    });
  };

  handleAlphaChange = event => {
    const alpha = clampAlpha(event.target.value);
    this.setState(current => {
      const color = { ...current.color, a: alpha };
      this.emitChange(color);
      return { color };
    });
  };

  render() {
    const { color } = this.state;
    const swatchStyle = {
      ...styles.color,
      background: `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`,
    };

    return (
      <div>
        <button
          type="button"
          style={styles.swatch}
          onClick={this.handleClick}
          aria-expanded={this.state.displayColorPicker}
          aria-label="Çizim rengini seç"
        >
          <span style={swatchStyle} aria-hidden="true" />
        </button>
        {this.state.displayColorPicker ? (
          <div style={styles.popover} role="group" aria-label="Renk ayarları">
            <button type="button" style={styles.cover} onClick={this.handleClose} aria-label="Renk seçiciyi kapat" />
            <div style={styles.controls}>
              <label>
                Renk
                <input
                  type="color"
                  value={rgbToHex(color)}
                  onChange={this.handleColorChange}
                />
              </label>
              <label style={styles.alpha}>
                <span>Saydamlık</span>
                <output>{Math.round(color.a * 100)}%</output>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={color.a}
                  onChange={this.handleAlphaChange}
                />
              </label>
            </div>
          </div>
        ) : null}
      </div>
    );
  }
}

export default ColorPicker;
