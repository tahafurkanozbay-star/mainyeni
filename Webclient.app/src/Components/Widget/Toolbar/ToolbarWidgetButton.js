import { OverlayTrigger, Tooltip } from "react-bootstrap";

export const ToolbarWidgetButton = ({ tooltipText, onClick, image }) => {
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
                <img
                    className="toolbarwidget-button-icon"
                    src={`images/icons/toolbar/${image}`}
                    alt=""
                    aria-hidden="true"
                />
            </button>
        </OverlayTrigger>
    );
};
