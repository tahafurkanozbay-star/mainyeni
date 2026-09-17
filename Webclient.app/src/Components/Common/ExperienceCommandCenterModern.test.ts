import { describe, expect, it } from 'vitest';
import {
  EXPERIENCE_COMMANDS,
  filterExperienceCommands,
} from './ExperienceCommandCenterModern';

describe('ExperienceCommandCenterModern catalog', () => {
  it('combines core tools and the complete city service catalog', () => {
    expect(EXPERIENCE_COMMANDS).toHaveLength(49);
    expect(EXPERIENCE_COMMANDS.filter(command => command.id.startsWith('service-'))).toHaveLength(40);
  });

  it('matches Turkish labels with accent-insensitive queries', () => {
    const results = filterExperienceCommands(EXPERIENCE_COMMANDS, 'kadin danisma');
    expect(results.map(command => command.label)).toContain('Kadın Danışma Merkezleri');
  });

  it('requires every query token to match the searchable command context', () => {
    const results = filterExperienceCommands(EXPERIENCE_COMMANDS, 'ego metro');
    expect(results).toHaveLength(1);
    expect(results[0]?.label).toBe('Metro Hattı');
  });

  it('keeps map analysis commands discoverable', () => {
    const results = filterExperienceCommands(EXPERIENCE_COMMANDS, 'ölçüm alan');
    expect(results.map(command => command.id)).toContain('measure');
  });
});

