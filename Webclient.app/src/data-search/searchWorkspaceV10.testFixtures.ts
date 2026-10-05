import type { DatasetSnapshot } from './contracts';
import { createDataSearchRuntime } from './searchRuntime';
import { createSearchRecoveryRuntimeV8 } from './searchRecoveryRuntimeV8';
import { createSearchExperienceRuntimeV9 } from './searchExperienceRuntimeV9';
import { createSearchWorkspaceRuntimeV10 } from './searchWorkspaceRuntimeV10';

export const workspaceRowsV10 = () => [
  {
    id: 'hospital-cankaya',
    name: 'Çankaya Devlet Hastanesi',
    category: 'Sağlık',
    type: 'Hastane',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Atatürk Bulvarı',
    address: 'Atatürk Bulvarı No 10 Çankaya Ankara',
    postalCode: '06420',
    lat: 39.9208,
    lon: 32.8541,
  },
  {
    id: 'hospital-altindag',
    name: 'Altındağ Şehir Hastanesi',
    category: 'Sağlık',
    type: 'Hastane',
    district: 'Altındağ',
    neighborhood: 'Ulus',
    street: 'Anafartalar Caddesi',
    address: 'Anafartalar Caddesi No 28 Altındağ Ankara',
    postalCode: '06050',
    lat: 39.9421,
    lon: 32.856,
  },
  {
    id: 'park-kizilay',
    name: 'Atatürk Parkı',
    category: 'Park',
    type: 'Kent Parkı',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Karanfil Sokak',
    address: 'Karanfil Sokak No 3 Çankaya Ankara',
    postalCode: '06420',
    lat: 39.9198,
    lon: 32.8529,
  },
  {
    id: 'park-seymenler',
    name: 'Seğmenler Parkı',
    category: 'Park',
    type: 'Kent Parkı',
    district: 'Çankaya',
    neighborhood: 'Çankaya',
    street: 'İran Caddesi',
    address: 'İran Caddesi Çankaya Ankara',
    postalCode: '06680',
    lat: 39.9026,
    lon: 32.8604,
  },
  {
    id: 'municipality-cankaya',
    name: 'Çankaya Belediyesi',
    category: 'Kamu',
    type: 'Belediye',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Ziya Gökalp Caddesi',
    address: 'Ziya Gökalp Caddesi No 7 Çankaya Ankara',
    postalCode: '06420',
    lat: 39.9212,
    lon: 32.8537,
  },
  {
    id: 'culture-ulus',
    name: 'Ulus Kültür Merkezi',
    category: 'Kültür',
    type: 'Kültür Merkezi',
    district: 'Altındağ',
    neighborhood: 'Ulus',
    street: 'Anafartalar Caddesi',
    address: 'Anafartalar Caddesi No 15 Altındağ Ankara',
    postalCode: '06050',
    lat: 39.941,
    lon: 32.855,
  },
  {
    id: 'school-bahceli',
    name: 'Bahçelievler Anadolu Lisesi',
    category: 'Eğitim',
    type: 'Lise',
    district: 'Çankaya',
    neighborhood: 'Bahçelievler',
    street: 'Aşkabat Caddesi',
    address: 'Aşkabat Caddesi No 20 Çankaya Ankara',
    postalCode: '06490',
    lat: 39.925,
    lon: 32.826,
  },
  {
    id: 'library-adnan',
    name: 'Adnan Ötüken İl Halk Kütüphanesi',
    category: 'Kültür',
    type: 'Kütüphane',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Kumrular Caddesi',
    address: 'Kumrular Caddesi No 3 Çankaya Ankara',
    postalCode: '06420',
    lat: 39.9224,
    lon: 32.853,
  },
] as const;

export const workspaceDatasetV10 = (key = 'ankara'): DatasetSnapshot =>
  createDataSearchRuntime().register(key, workspaceRowsV10());

export const createWorkspaceExperienceV10 = (options: { blockedWindow?: boolean } = {}) => {
  const recovery = createSearchRecoveryRuntimeV8({
    correction: {
      minimumAutoApplyScore: 100,
      minimumAutoApplyMargin: 5,
      maximumAutoEditDistance: 2,
    },
    registry: options.blockedWindow ? { execution: { maximumResultWindow: 100 } } : {},
  });
  recovery.register(workspaceDatasetV10());
  return createSearchExperienceRuntimeV9(recovery, {
    defaultGrouping: 'category',
    history: { maxEntries: 16, maxSuggestions: 8 },
    selection: { pageStep: 2, maxSelected: 8 },
  });
};

export const createWorkspaceRuntimeV10 = (options: { blockedWindow?: boolean } = {}) => {
  const experience = createWorkspaceExperienceV10(options);
  const workspace = createSearchWorkspaceRuntimeV10(experience, {
    handoff: {
      maxResults: 64,
      maxFacets: 8,
      maxFacetBuckets: 24,
      maxActions: 96,
      maxBadgesPerResult: 8,
    },
    state: { maxSelected: 8, maxHistory: 32 },
    accessibility: { maxAnnouncements: 8, maxResultFacts: 64, maxActionFacts: 96 },
    maxActionHistory: 64,
    maxModelHistory: 32,
  });
  return { experience, workspace };
};
