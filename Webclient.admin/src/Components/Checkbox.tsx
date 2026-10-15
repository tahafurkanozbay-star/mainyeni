import { AiOutlineCheckSquare } from "react-icons/ai";
import { BiSquare } from "react-icons/bi";

// A native toggle button supports keyboard activation and focus by default.
export const Checkbox = (props) => (
    <button
        type="button"
        aria-pressed={Boolean(props.checked)}
        onClick={(event) => props.toggle(event)}
        style={{ display: "inline-flex", alignItems: "center", gap: "0.375rem", background: "none", border: 0, padding: 0, color: "inherit", cursor: "pointer" }}
    >
        {props.checked
            ? <AiOutlineCheckSquare className="checkbox" aria-hidden="true" />
            : <BiSquare className="checkbox" aria-hidden="true" />}
        <span>{props.text}</span>
    </button>
);
