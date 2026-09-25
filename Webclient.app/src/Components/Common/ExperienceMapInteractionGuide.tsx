import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  createMapInteractionExperienceModel,
  type MapInteractionExperienceModel,
  type MapInteractionSnapshot,
} from '../../experience/mapInteractionExperienceModel';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import './experience-map-interaction-guide.css';

export interface ExperienceMapInteractionGuideProps {
  readonly model?: MapInteractionExperienceModel;
  readonly mapTargetId?: string;
}

const GUIDE_ID = 'experience-map-interaction-guide';
const NAVIGATION_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  '+',
  '=',
  'Add',
  '-',
  '_',
  'Subtract',
  'Escape',
  'Enter',
  ' ',
]);

const isTextEntry = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
};

const ownsMapFocus = (target: EventTarget | null, mapTargetId: string): boolean => {
  if (!(target instanceof Node)) return false;
  const mapTarget = document.getElementById(mapTargetId);
  return mapTarget instanceof HTMLElement && (target === mapTarget || mapTarget.contains(target));
};

const mergeDescribedBy = (existing: string | null, id: string): string => {
  const values = (existing ?? '').split(/\s+/).filter(Boolean);
  if (!values.includes(id)) values.push(id);
  return values.join(' ');
};

const removeDescribedBy = (existing: string | null, id: string): string | null => {
  const values = (existing ?? '').split(/\s+/).filter((value) => value && value !== id);
  return values.length > 0 ? values.join(' ') : null;
};

export const ExperienceMapInteractionGuide = ({
  model: suppliedModel,
  mapTargetId = 'esri-map-container',
}: ExperienceMapInteractionGuideProps): ReactNode => {
  const model = useMemo<MapInteractionExperienceModel>(() => suppliedModel ?? createMapInteractionExperienceModel({
    onObserverError(error) {
      runtimeDiagnostics.captureError(error, {
        source: 'experience.map-interaction-guide.observer',
      }, 'warn');
    },
  }), [suppliedModel]);
  const [snapshot, setSnapshot] = useState<MapInteractionSnapshot>(() => model.snapshot());

  useEffect(() => model.subscribe(setSnapshot), [model]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const mapTarget = document.getElementById(mapTargetId);
    if (!(mapTarget instanceof HTMLElement)) return undefined;

    const previousDescribedBy = mapTarget.getAttribute('aria-describedby');
    mapTarget.setAttribute('aria-describedby', mergeDescribedBy(previousDescribedBy, GUIDE_ID));

    return () => {
      const current = mapTarget.getAttribute('aria-describedby');
      const cleaned = removeDescribedBy(current, GUIDE_ID);
      if (cleaned) mapTarget.setAttribute('aria-describedby', cleaned);
      else mapTarget.removeAttribute('aria-describedby');
    };
  }, [mapTargetId]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTextEntry(event.target)) return;
      if (!NAVIGATION_KEYS.has(event.key) && !ownsMapFocus(event.target, mapTargetId)) return;
      model.recordKeyboard(event.key, event.shiftKey);
    };
    const onPointerDown = (): void => model.recordPointer();
    const onFocusIn = (event: FocusEvent): void => model.setMapFocused(ownsMapFocus(event.target, mapTargetId));
    const onFocusOut = (event: FocusEvent): void => {
      if (!ownsMapFocus(event.relatedTarget, mapTargetId)) model.setMapFocused(false);
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
    };
  }, [mapTargetId, model]);

  useEffect(() => {
    if (!snapshot.keyboardHintsVisible) return;
    runtimeDiagnostics.record('experience.map-keyboard-guidance.visible', {
      revision: snapshot.revision,
      intent: snapshot.lastIntent,
      interactionCount: snapshot.interactionCount,
    });
  }, [snapshot.interactionCount, snapshot.keyboardHintsVisible, snapshot.lastIntent, snapshot.revision]);

  return (
    <aside
      id={GUIDE_ID}
      className="experience-map-interaction-guide"
      data-input-modality={snapshot.modality}
      data-map-focused={String(snapshot.mapFocused)}
      data-visible={String(snapshot.keyboardHintsVisible)}
      aria-label="Harita klavye kullanım rehberi"
      role="note"
    >
      <strong className="experience-map-interaction-guide__title">Harita klavye kullanımı</strong>
      <span className="experience-map-interaction-guide__summary">
        Tab ile harita kontrollerine geçin; yön tuşlarıyla gezinme yapın; artı ve eksi tuşlarıyla yakınlaştırın veya uzaklaştırın.
      </span>
      <span className="experience-map-interaction-guide__secondary">
        Sayfanın başındaki hızlı erişim bağlantılarıyla katman menüsüne ve harita araçlarına doğrudan ulaşabilirsiniz.
      </span>
      <span
        className="experience-map-interaction-guide__announcement"
        aria-live="polite"
        aria-atomic="true"
      >
        {snapshot.announcement}
      </span>
    </aside>
  );
};

export default ExperienceMapInteractionGuide;
