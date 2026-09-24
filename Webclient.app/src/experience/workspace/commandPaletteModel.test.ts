import { createCommandPaletteModel, type CommandPaletteItem } from './commandPaletteModel';
const ITEMS: readonly CommandPaletteItem[] = Object.freeze([
 { id:'search-address', label:'Adres ara', description:'Adres ve kapı numarası bul', keywords:['arama','adres'], group:'navigation', priority:10 },
 { id:'focus-map', label:'Haritaya odaklan', description:'Harita çalışma alanına geç', keywords:['harita','map'], group:'map' },
 { id:'layers', label:'Katmanları aç', description:'Katman panelini göster', keywords:['layer','panel'], group:'tools' },
 { id:'measure', label:'Ölçüm aracını aç', description:'Mesafe ve alan ölç', keywords:['mesafe','alan'], group:'tools' },
 { id:'toggle-3d', label:'3B görünüme geç', description:'Sahne görünümünü etkinleştir', keywords:['3d','sahne'], group:'view' },
 { id:'help', label:'Klavye yardımını aç', description:'Kısayolları göster', keywords:['yardım','kısayol'], group:'help' },
]);
describe('commandPaletteModel', () => {
 test('bounds and ranks defaults deterministically', () => { const state=createCommandPaletteModel({items:ITEMS,maxResults:3}).getState(); expect(state.matches).toHaveLength(3); expect(state.activeId).toBe('search-address'); expect(Object.isFrozen(state)).toBe(true); });
 test('opens, filters and clears query on close', () => { const model=createCommandPaletteModel({items:ITEMS}); expect(model.open().open).toBe(true); expect(model.setQuery('katman').matches[0]?.item.id).toBe('layers'); expect(model.close().query).toBe(''); });
 test('matches description, aliases and multiple tokens', () => { const model=createCommandPaletteModel({items:ITEMS}); expect(model.setQuery('mesafe').matches[0]?.item.id).toBe('measure'); expect(model.setQuery('layer').matches[0]?.item.id).toBe('layers'); expect(model.setQuery('harita odak').matches[0]?.item.id).toBe('focus-map'); });
 test('supports tolerant subsequence matching', () => { const model=createCommandPaletteModel({items:ITEMS}); expect(model.setQuery('hrta').matches.map(m=>m.item.id)).toContain('focus-map'); expect(model.setQuery('zzzzzz').resultCount).toBe(0); });
 test('wraps keyboard navigation and supports boundaries', () => { const model=createCommandPaletteModel({items:ITEMS,maxResults:3}); const first=model.getState().activeId; expect(model.move(-1).activeId).toBe(model.getState().matches.at(-1)?.item.id); expect(model.home().activeId).toBe(first); expect(model.end().activeIndex).toBe(2); });
 test('resets active item after query changes', () => { const model=createCommandPaletteModel({items:ITEMS}); model.end(); const state=model.setQuery('adres'); expect(state.activeIndex).toBe(0); expect(state.activeId).toBe('search-address'); });
 test('preserves active identity when replacing items', () => { const model=createCommandPaletteModel({items:ITEMS}); model.move(1); const active=model.getState().activeId; expect(model.replaceItems([...ITEMS].reverse()).activeId).toBe(active); });
 test('falls back when active identity disappears', () => { const model=createCommandPaletteModel({items:ITEMS}); model.end(); const removed=model.getState().activeId; const state=model.replaceItems(ITEMS.filter(item=>item.id!==removed)); expect(state.activeIndex).toBe(0); expect(state.activeId).not.toBe(removed); });
 test('normalizes Turkish dotted I', () => { const model=createCommandPaletteModel({items:[{id:'istanbul',label:'İstanbul görünümü',group:'view'}]}); expect(model.setQuery(' İSTANBUL ').matches[0]?.item.id).toBe('istanbul'); });
 test('exposes accessible match metadata', () => { const match=createCommandPaletteModel({items:ITEMS}).setQuery('katman').matches[0]; expect(match?.labelRanges).toEqual([{start:0,end:6}]); expect(createCommandPaletteModel({items:ITEMS}).setQuery('layer').matches[0]?.keywordMatches).toContain('layer'); });
 test('rejects duplicate and invalid identities', () => { expect(()=>createCommandPaletteModel({items:[ITEMS[0]!,ITEMS[0]!]})).toThrow(/Duplicate/); expect(()=>createCommandPaletteModel({items:[{id:'',label:'A',group:'help'}]})).toThrow(/id is required/); });
 test('keeps disabled commands discoverable', () => { const match=createCommandPaletteModel({items:[{id:'offline',label:'Çevrimdışı araç',group:'tools',disabled:true,disabledReason:'Ağ gerekli'}]}).setQuery('çevrimdışı').matches[0]; expect(match?.item.disabled).toBe(true); expect(match?.item.disabledReason).toBe('Ağ gerekli'); });
});
