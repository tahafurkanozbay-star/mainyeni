import type { MouseEvent, ReactNode } from "react";
import { AiOutlineCheckSquare } from "react-icons/ai";
import { BiSquare } from "react-icons/bi";

export interface CheckboxProps {
  readonly checked: boolean;
  readonly text: ReactNode;
  readonly toggle: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly disabled?: boolean;
  readonly label?: string;
}

export const Checkbox = ({
  checked,
  text,
  toggle,
  disabled = false,
  label,
}: CheckboxProps) => (
  <button
    type="button"
    className="btn btn-link p-0 text-start text-decoration-none"
    role="checkbox"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={toggle}
  >
    {checked
      ? <AiOutlineCheckSquare className="checkbox" aria-hidden="true" />
      : <BiSquare className="checkbox" aria-hidden="true" />}
    <span>{text}</span>
  </button>
);
