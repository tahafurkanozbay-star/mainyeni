import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import './ExperiencePrimitives.css';

interface FieldFrameProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly required?: boolean | undefined;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

const joinDescribedBy = (
  caller: string | undefined,
  generated: string | undefined,
): string | undefined => [caller, generated].filter(Boolean).join(' ') || undefined;

const FieldFrame = ({
  id,
  label,
  hint,
  error,
  required,
  children,
  className = '',
}: FieldFrameProps): ReactNode => (
  <div className={`kr-field ${error ? 'is-invalid' : ''} ${className}`.trim()}>
    <label className="kr-field__label" htmlFor={id}>
      {label}
      {required ? <span className="kr-field__required" aria-hidden="true"> *</span> : null}
    </label>
    {children}
    {hint && !error ? <div id={`${id}-hint`} className="kr-field__hint">{hint}</div> : null}
    {error ? <div id={`${id}-error`} className="kr-field__error" role="alert">{error}</div> : null}
  </div>
);

const useFieldId = (providedId: string | undefined, prefix: string): string => {
  const generatedId = useId();
  return providedId ?? `${prefix}-${generatedId.replace(/:/g, '')}`;
};

export interface ExperienceInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly id?: string;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly fieldClassName?: string;
}

export function ExperienceInput({
  id: providedId,
  label,
  hint,
  error,
  required,
  className = '',
  fieldClassName = '',
  'aria-describedby': callerDescribedBy,
  ...props
}: ExperienceInputProps): ReactNode {
  const id = useFieldId(providedId, 'kr-input');
  const generatedDescribedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <FieldFrame
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={fieldClassName}
    >
      <input
        {...props}
        id={id}
        required={required}
        className={`kr-input ${className}`.trim()}
        aria-invalid={error ? true : undefined}
        aria-describedby={joinDescribedBy(callerDescribedBy, generatedDescribedBy)}
      />
    </FieldFrame>
  );
}

export interface ExperienceSelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  readonly id?: string;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly fieldClassName?: string;
}

export function ExperienceSelect({
  id: providedId,
  label,
  hint,
  error,
  required,
  className = '',
  fieldClassName = '',
  children,
  'aria-describedby': callerDescribedBy,
  ...props
}: ExperienceSelectProps): ReactNode {
  const id = useFieldId(providedId, 'kr-select');
  const generatedDescribedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <FieldFrame
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={fieldClassName}
    >
      <select
        {...props}
        id={id}
        required={required}
        className={`kr-select ${className}`.trim()}
        aria-invalid={error ? true : undefined}
        aria-describedby={joinDescribedBy(callerDescribedBy, generatedDescribedBy)}
      >
        {children}
      </select>
    </FieldFrame>
  );
}

export interface ExperienceTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  readonly id?: string;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly fieldClassName?: string;
}

export function ExperienceTextarea({
  id: providedId,
  label,
  hint,
  error,
  required,
  className = '',
  fieldClassName = '',
  'aria-describedby': callerDescribedBy,
  ...props
}: ExperienceTextareaProps): ReactNode {
  const id = useFieldId(providedId, 'kr-textarea');
  const generatedDescribedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <FieldFrame
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={fieldClassName}
    >
      <textarea
        {...props}
        id={id}
        required={required}
        className={`kr-textarea ${className}`.trim()}
        aria-invalid={error ? true : undefined}
        aria-describedby={joinDescribedBy(callerDescribedBy, generatedDescribedBy)}
      />
    </FieldFrame>
  );
}

export interface ExperienceCheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> {
  readonly id?: string;
  readonly label: string;
  readonly description?: string;
}

export function ExperienceCheckbox({
  id: providedId,
  label,
  description,
  className = '',
  ...props
}: ExperienceCheckboxProps): ReactNode {
  const id = useFieldId(providedId, 'kr-checkbox');
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <label className={`kr-checkbox ${className}`.trim()} htmlFor={id}>
      <input
        {...props}
        id={id}
        type="checkbox"
        className="kr-checkbox__input"
        aria-describedby={descriptionId}
      />
      <span className="kr-checkbox__body">
        <span className="kr-checkbox__label">{label}</span>
        {description ? (
          <span id={descriptionId} className="kr-checkbox__description">{description}</span>
        ) : null}
      </span>
    </label>
  );
}

export interface ExperienceFieldsetProps {
  readonly legend: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly disabled?: boolean;
}

export function ExperienceFieldset({
  legend,
  description,
  children,
  className = '',
  disabled = false,
}: ExperienceFieldsetProps): ReactNode {
  return (
    <fieldset className={`kr-fieldset ${className}`.trim()} disabled={disabled}>
      <legend className="kr-fieldset__legend">{legend}</legend>
      {description ? <p className="kr-fieldset__description">{description}</p> : null}
      <div className="kr-fieldset__content">{children}</div>
    </fieldset>
  );
}
