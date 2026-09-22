import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExperienceFormField, getExperienceFieldAria } from './ExperienceFormField';
import type { FieldValidationState } from '../../experience/formValidationRuntime';

const state = (overrides: Partial<FieldValidationState> = {}): FieldValidationState => ({
  name: 'address',
  value: '',
  initialValue: '',
  dirty: false,
  touched: false,
  validating: false,
  issues: [],
  invalid: false,
  ...overrides,
});

describe('ExperienceFormField', () => {
  it('associates its visible label with the control id', () => {
    render(
      <ExperienceFormField id="address" label="Adres" required>
        <input id="address" aria-label="Adres" />
      </ExperienceFormField>,
    );
    expect(screen.getByLabelText('Adres *')).toBeInTheDocument();
  });

  it('shows optional context for non-required fields', () => {
    render(
      <ExperienceFormField id="note" label="Not">
        <textarea id="note" aria-label="Not" />
      </ExperienceFormField>,
    );
    expect(screen.getByText('İsteğe bağlı')).toBeInTheDocument();
  });

  it('supports localized optional copy', () => {
    render(
      <ExperienceFormField id="note" label="Not" optionalLabel="Zorunlu değil">
        <textarea id="note" aria-label="Not" />
      </ExperienceFormField>,
    );
    expect(screen.getByText('Zorunlu değil')).toBeInTheDocument();
  });

  it('renders hints with deterministic ids', () => {
    render(
      <ExperienceFormField id="query" label="Arama" hint="En az üç karakter girin.">
        <input id="query" aria-label="Arama" />
      </ExperienceFormField>,
    );
    expect(screen.getByText('En az üç karakter girin.')).toHaveAttribute('id', 'query-hint');
  });

  it('announces validation errors assertively', () => {
    render(
      <ExperienceFormField
        id="address"
        label="Adres"
        state={state({ invalid: true, issues: [{ code: 'required', message: 'Adres zorunludur.', severity: 'error' }] })}
      >
        <input id="address" aria-label="Adres" />
      </ExperienceFormField>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('id', 'address-error');
    expect(alert).toHaveTextContent('Adres zorunludur.');
  });

  it('keeps warnings non-assertive', () => {
    render(
      <ExperienceFormField
        id="geometry"
        label="Geometri"
        state={state({ issues: [{ code: 'precision', message: 'Yaklaşık konum.', severity: 'warning' }] })}
      >
        <input id="geometry" aria-label="Geometri" />
      </ExperienceFormField>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Yaklaşık konum.');
  });

  it('exposes validation progress through a polite status', () => {
    render(
      <ExperienceFormField id="parcel" label="Parsel" state={state({ validating: true })}>
        <input id="parcel" aria-label="Parsel" />
      </ExperienceFormField>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Doğrulanıyor');
  });

  it('derives control aria metadata from field state', () => {
    expect(getExperienceFieldAria(
      state({ invalid: true, validating: true, issues: [{ code: 'required', message: 'Zorunlu' }] }),
      'address',
      true,
    )).toEqual({
      'aria-invalid': true,
      'aria-describedby': 'address-hint address-error',
      'aria-busy': true,
    });
  });

  it('omits unnecessary aria metadata for a quiet valid field', () => {
    expect(getExperienceFieldAria(state(), 'address', false)).toEqual({
      'aria-invalid': undefined,
      'aria-describedby': undefined,
      'aria-busy': undefined,
    });
  });
});
