import type { ReactNode } from 'react';
import type { FieldValidationState } from '../../experience/formValidationRuntime';
import './experience-form-field.css';

export interface ExperienceFormFieldProps {
  readonly id: string;
  readonly label: string;
  readonly state?: FieldValidationState;
  readonly hint?: ReactNode;
  readonly required?: boolean;
  readonly optionalLabel?: string;
  readonly children: ReactNode;
}

export function ExperienceFormField({
  id,
  label,
  state,
  hint,
  required = false,
  optionalLabel = 'İsteğe bağlı',
  children,
}: ExperienceFormFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = state?.issues.length ? `${id}-error` : undefined;
  const errors = state?.issues.filter((issue) => (issue.severity ?? 'error') === 'error') ?? [];
  const warnings = state?.issues.filter((issue) => issue.severity === 'warning') ?? [];

  return (
    <div
      className="experience-form-field"
      data-invalid={errors.length ? 'true' : undefined}
      data-dirty={state?.dirty ? 'true' : undefined}
      data-validating={state?.validating ? 'true' : undefined}
    >
      <div className="experience-form-field__heading">
        <label className="experience-form-field__label" htmlFor={id}>
          {label}
          {required ? <span aria-hidden="true" className="experience-form-field__required"> *</span> : null}
        </label>
        {!required ? <span className="experience-form-field__optional">{optionalLabel}</span> : null}
      </div>
      {hint ? <div className="experience-form-field__hint" id={hintId}>{hint}</div> : null}
      <div
        className="experience-form-field__control"
        data-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
      >
        {children}
      </div>
      {state?.validating ? (
        <div className="experience-form-field__status" role="status" aria-live="polite">
          Doğrulanıyor…
        </div>
      ) : null}
      {errors.length ? (
        <div className="experience-form-field__issues" id={errorId} role="alert" aria-live="assertive">
          {errors.map((issue) => <div key={`${issue.code}:${issue.message}`}>{issue.message}</div>)}
        </div>
      ) : null}
      {warnings.length ? (
        <div className="experience-form-field__warnings" role="status">
          {warnings.map((issue) => <div key={`${issue.code}:${issue.message}`}>{issue.message}</div>)}
        </div>
      ) : null}
    </div>
  );
}

export function getExperienceFieldAria(state: FieldValidationState | undefined, id: string, hasHint: boolean) {
  const describedBy = [hasHint ? `${id}-hint` : null, state?.issues.length ? `${id}-error` : null]
    .filter((value): value is string => Boolean(value));
  return {
    'aria-invalid': state?.invalid || undefined,
    'aria-describedby': describedBy.length ? describedBy.join(' ') : undefined,
    'aria-busy': state?.validating || undefined,
  } as const;
}
