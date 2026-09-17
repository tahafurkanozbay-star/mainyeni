import { OverlayTrigger, Tooltip } from "react-bootstrap";

const ToolbarGlyph = ({ name }) => {
    const common = {
        width: 22,
        height: 22,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.8,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true
    };

    switch (name) {
        case "feedback":
            return <svg {...common}><path d="M7 18.5 3.5 21l1-4A8.2 8.2 0 0 1 3 12c0-4.4 4-8 9-8s9 3.6 9 8-4 8-9 8a10.6 10.6 0 0 1-5-.5Z" /><path d="M8 12h.01M12 12h.01M16 12h.01" /></svg>;
        case "basemap":
            return <svg {...common}><path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" /><path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5" /></svg>;
        case "address":
            return <svg {...common}><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></svg>;
        case "location":
            return <svg {...common}><circle cx="12" cy="12" r="5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /></svg>;
        case "parcel":
            return <svg {...common}><path d="m4 6 5-3 6 3 5-3v15l-5 3-6-3-5 3V6Z" /><path d="M9 3v15M15 6v15" /></svg>;
        case "measure":
            return <svg {...common}><path d="m5 19 14-14 2 2L7 21l-2-2Z" /><path d="m13 7 4 4M10 10l2 2M7 13l2 2" /></svg>;
        case "streetview":
            return <svg {...common}><circle cx="12" cy="5" r="2.3" /><path d="M8 21v-5l-2-2 2-5h8l2 5-2 2v5M9 12h6M12 12v9" /></svg>;
        case "home":
            return <svg {...common}><path d="m3 11 9-8 9 8" /><path d="M5.5 9.5V21h13V9.5M9 21v-7h6v7" /></svg>;
        default:
            return <svg {...common}><circle cx="12" cy="12" r="8" /></svg>;
    }
};

export const ToolbarWidgetButton = ({ tooltipText, onClick, image, icon }) => {
    const tooltipId = `toolbar-tooltip-${String(image || tooltipText || "control").replace(/[^a-z0-9_-]/gi, "-")}`;

    return (
        <OverlayTrigger
            placement="left"
            overlay={<Tooltip id={tooltipId}>{tooltipText}</Tooltip>}
        >
            <button
                type="button"
                className="toolbarwidget-button"
                onClick={onClick}
                aria-label={tooltipText}
            >
                {icon ? (
                    <span className="toolbarwidget-button-glyph" aria-hidden="true">
                        <ToolbarGlyph name={icon} />
                    </span>
                ) : (
                    <img
                        className="toolbarwidget-button-icon"
                        src={`images/icons/toolbar/${image}`}
                        alt=""
                        aria-hidden="true"
                    />
                )}
            </button>
        </OverlayTrigger>
    );
};
