import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

interface FieldFrameProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly required?: boolean;
  readonly children: ReactNode;
}

const FieldFrame = ({ id, label, hint, error, required, children }: FieldFrameProps) => (
  <div className={`kr-field ${error ? 'is-invalid' : ''}`}>
    <label className="kr-field__label" htmlFor={id}>{label}{required && <span aria-hidden="true"> *</span>}</label>
    {children}
    {hint && !error && <div id={`${id}-hint`} className="kr-field__hint">{hint}</div>}
    {error && <div id={`${id}-error`} className="kr-field__error" role="alert">{error}</div>}
  </div>
);

export interface ExperienceInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly id?: string;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
}

export function ExperienceInput({ id: providedId, label, hint, error, required, className = '', ...props }: ExperienceInputProps) {
  const generatedId = useId();
  const id = providedId ?? `kr-input-${generatedId.replace(/:/g, '')}`;
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} required={required}>
      <input {...props} id={id} required={required} className={`kr-input ${className}`.trim()} aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy} />
    </FieldFrame>
  );
}

export interface ExperienceSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  readonly id?: string;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
}

export function ExperienceSelect({ id: providedId, label, hint, error, required, className = '', children, ...props }: ExperienceSelectProps) {
  const generatedId = useId();
  const id = providedId ?? `kr-select-${generatedId.replace(/:/g, '')}`;
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} required={required}>
      <select {...props} id={id} required={required} className={`kr-select ${className}`.trim()} aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy}>{children}</select>
    </FieldFrame>
  );
}

export interface ExperienceTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  readonly id?: string;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
}

export function ExperienceTextarea({ id: providedId, label, hint, error, required, className = '', ...props }: ExperienceTextareaProps) {
  const generatedId = useId();
  const id = providedId ?? `kr-textarea-${generatedId.replace(/:/g, '')}`;
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} required={required}>
      <textarea {...props} id={id} required={required} className={`kr-textarea ${className}`.trim()} aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy} />
    </FieldFrame>
  );
}

export interface ExperienceFieldsetProps {
  readonly legend: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export const ExperienceFieldset = ({ legend, description, children, className = '' }: ExperienceFieldsetProps) => (
  <fieldset className={`kr-fieldset ${className}`.trim()}>
    <legend className="kr-fieldset__legend">{legend}</legend>
    {description && <p className="kr-fieldset__description">{description}</p>}
    <div className="kr-fieldset__content">{children}</div>
  </fieldset>
);
