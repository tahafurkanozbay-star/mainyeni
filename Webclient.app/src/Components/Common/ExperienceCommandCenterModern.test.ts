import { describe, expect, it } from 'vitest';
import {
  EXPERIENCE_COMMANDS,
  filterExperienceCommands,
} from './ExperienceCommandCenterModern';

describe('ExperienceCommandCenterModern catalog', () => {
  it('combines core tools and the complete city service catalog', () => {
    expect(EXPERIENCE_COMMANDS).toHaveLength(51);
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

  it('keeps global settings and accessibility discoverable without utility buttons', () => {
    expect(filterExperienceCommands(EXPERIENCE_COMMANDS, 'çalışma alanı ayarları').map(command => command.id))
      .toContain('workspace-settings');
    expect(filterExperienceCommands(EXPERIENCE_COMMANDS, 'erişilebilirlik merkezi').map(command => command.id))
      .toContain('accessibility-center');

    expect(EXPERIENCE_COMMANDS.find(command => command.id === 'help')?.scopes).toEqual(['map', 'help']);
    expect(EXPERIENCE_COMMANDS.find(command => command.id === 'workspace-settings')?.scopes).toEqual(['map']);
    expect(EXPERIENCE_COMMANDS.find(command => command.id === 'accessibility-center')?.scopes).toEqual(['map']);
    expect(EXPERIENCE_COMMANDS.find(command => command.id === 'help')?.shortcut).toBe('Shift+?');
    expect(EXPERIENCE_COMMANDS.find(command => command.id === 'help')?.event).toBe('workspace-help');
  });
});

