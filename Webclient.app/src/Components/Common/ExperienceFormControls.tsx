import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

type FieldMessage = { readonly error?: string; readonly hint?: string };
type FieldShellMessage = { readonly error: string | undefined; readonly hint: string | undefined };

const FieldShell = ({ id, label, required, message, children }: { id: string; label: string; required: boolean | undefined; message: FieldShellMessage; children: ReactNode }) => {
  const messageId = `${id}-message`;
  return (
    <div className={`experience-field${message.error ? ' experience-field--invalid' : ''}`}>
      <label className="experience-field__label" htmlFor={id}>{label}{required ? <span className="experience-field__required" aria-hidden="true"> *</span> : null}</label>
      {children}
      {message.error || message.hint ? <p id={messageId} className="experience-field__message" role={message.error ? 'alert' : undefined}>{message.error ?? message.hint}</p> : null}
    </div>
  );
};

export interface ExperienceInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>, FieldMessage { readonly id?: string; readonly label: string }
export const ExperienceInput = forwardRef<HTMLInputElement, ExperienceInputProps>(({ id: providedId, label, error, hint, required, className = '', ...props }, ref) => {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const messageId = error || hint ? `${id}-message` : undefined;
  return <FieldShell id={id} label={label} required={required} message={{ error, hint }}><input {...props} ref={ref} id={id} required={required} aria-invalid={error ? true : undefined} aria-describedby={messageId} className={`experience-input ${className}`.trim()} /></FieldShell>;
});
ExperienceInput.displayName = 'ExperienceInput';

export interface ExperienceSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'>, FieldMessage { readonly id?: string; readonly label: string; readonly children: ReactNode }
export const ExperienceSelect = forwardRef<HTMLSelectElement, ExperienceSelectProps>(({ id: providedId, label, error, hint, required, className = '', children, ...props }, ref) => {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const messageId = error || hint ? `${id}-message` : undefined;
  return <FieldShell id={id} label={label} required={required} message={{ error, hint }}><select {...props} ref={ref} id={id} required={required} aria-invalid={error ? true : undefined} aria-describedby={messageId} className={`experience-select ${className}`.trim()}>{children}</select></FieldShell>;
});
ExperienceSelect.displayName = 'ExperienceSelect';

export interface ExperienceTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>, FieldMessage { readonly id?: string; readonly label: string }
export const ExperienceTextarea = forwardRef<HTMLTextAreaElement, ExperienceTextareaProps>(({ id: providedId, label, error, hint, required, className = '', ...props }, ref) => {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const messageId = error || hint ? `${id}-message` : undefined;
  return <FieldShell id={id} label={label} required={required} message={{ error, hint }}><textarea {...props} ref={ref} id={id} required={required} aria-invalid={error ? true : undefined} aria-describedby={messageId} className={`experience-textarea ${className}`.trim()} /></FieldShell>;
});
ExperienceTextarea.displayName = 'ExperienceTextarea';

export interface ExperienceFieldsetProps { readonly legend: string; readonly description?: string; readonly children: ReactNode; readonly disabled?: boolean }
export const ExperienceFieldset = ({ legend, description, children, disabled }: ExperienceFieldsetProps): ReactNode => <fieldset className="experience-fieldset" disabled={disabled}><legend>{legend}</legend>{description ? <p className="experience-fieldset__description">{description}</p> : null}<div className="experience-fieldset__content">{children}</div></fieldset>;
