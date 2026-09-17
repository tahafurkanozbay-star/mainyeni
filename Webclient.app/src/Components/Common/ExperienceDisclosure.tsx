import { useId, useState, type ReactNode } from 'react';

export interface ExperienceDisclosureProps {
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
  readonly summary?: ReactNode;
  readonly className?: string;
}

export const ExperienceDisclosure = ({ title, children, defaultOpen = false, summary, className = '' }: ExperienceDisclosureProps): ReactNode => {
  const [open, setOpen] = useState(defaultOpen);
  const generatedId = useId();
  const panelId = `${generatedId}-panel`;

  return (
    <section className={`experience-disclosure ${open ? 'experience-disclosure--open' : ''} ${className}`.trim()}>
      <button
        type="button"
        className="experience-disclosure__trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="experience-disclosure__title">{title}</span>
        {summary ? <span className="experience-disclosure__summary">{summary}</span> : null}
        <span className="experience-disclosure__chevron" aria-hidden="true">⌄</span>
      </button>
      <div id={panelId} className="experience-disclosure__panel" hidden={!open}>
        {children}
      </div>
    </section>
  );
};

export interface ExperienceAccordionItem {
  readonly id: string;
  readonly title: ReactNode;
  readonly content: ReactNode;
  readonly summary?: ReactNode;
}

export interface ExperienceAccordionProps {
  readonly items: readonly ExperienceAccordionItem[];
  readonly label: string;
  readonly allowMultiple?: boolean;
  readonly initiallyOpen?: readonly string[];
}

export const ExperienceAccordion = ({ items, label, allowMultiple = true, initiallyOpen = [] }: ExperienceAccordionProps): ReactNode => {
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set(initiallyOpen));
  const generatedId = useId();

  const toggle = (id: string): void => {
    setOpenIds((current) => {
      const next = new Set(allowMultiple ? current : []);
      if (current.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="experience-accordion" aria-label={label}>
      {items.map((item) => {
        const open = openIds.has(item.id);
        const panelId = `${generatedId}-${item.id}-panel`;
        const triggerId = `${generatedId}-${item.id}-trigger`;
        return (
          <section key={item.id} className="experience-accordion__item">
            <h3 className="experience-accordion__heading">
              <button id={triggerId} type="button" className="experience-accordion__trigger" aria-expanded={open} aria-controls={panelId} onClick={() => toggle(item.id)}>
                <span>{item.title}</span>
                {item.summary ? <span className="experience-accordion__summary">{item.summary}</span> : null}
                <span aria-hidden="true" className="experience-accordion__chevron">⌄</span>
              </button>
            </h3>
            <div id={panelId} role="region" aria-labelledby={triggerId} className="experience-accordion__panel" hidden={!open}>{item.content}</div>
          </section>
        );
      })}
    </div>
  );
};
