import type { ReactNode } from 'react';
import './experience-data-disclaimer.css';

export interface ExperienceDataDisclaimerProps {
  readonly compact?: boolean;
}

export const ExperienceDataDisclaimer = ({
  compact = false,
}: ExperienceDataDisclaimerProps): ReactNode => (
  <aside
    aria-label="Veri kullanım uyarısı"
    className="experience-data-disclaimer"
    data-compact={compact ? 'true' : 'false'}
    role="note"
  >
    <span className="experience-data-disclaimer__icon" aria-hidden="true">i</span>
    <span className="experience-data-disclaimer__copy">
      <span>Sitede Gösterilen Veriler Bilgi Amaçlıdır.</span>{' '}
      <strong>Resmî İşlemlerde KULLANILAMAZ!</strong>
    </span>
  </aside>
);

export default ExperienceDataDisclaimer;
