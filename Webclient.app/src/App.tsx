import { useEffect, useState } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import './bootstrap-overrides.css';
import './styles.responsive.css';
import './Components/Common/experience-ui.css';
import './Components/Common/experience-quality.css';
import './Components/Common/experience-shell.css';
import './Components/Common/experience-data-ux.css';
import { MapComponent } from './Components/App/MapComponent';
import { Constants_LoadingStatus, type LoadingStatus } from './Core/Constants';
import { AppConfig } from './Core/AppConfig';
import { useWindowManager } from './Store/Managers/WindowManager';
import { FullScreenLoading } from './Components/Common/Loading';
import { FullScreenError } from './Components/Common/Error';
import { ExperienceUXLayer } from './Components/Common/ExperienceUXLayer';
import { ExperienceCommandCenterModern as ExperienceCommandCenter } from './Components/Common/ExperienceCommandCenterModern';
import { ExperienceThemeProvider } from './Components/Common/ExperienceDesignSystem';
import { ExperienceWorkspace } from './Components/Common/ExperienceWorkspace';
import { ExperienceRuntimeBridge } from './Components/Common/ExperienceRuntimeBridge';
import { configureArcgisModuleRuntime } from './gis-engine/arcgisModuleRuntime';
import { bootstrapApplication } from './platform/bootstrap/bootstrapApplication';
import { isBootstrapAbortError } from './platform/bootstrap/bootstrapCore';
import { runtimeDiagnostics } from './platform/runtime/runtimeDiagnostics';
import { DebugHelper } from './Toolbox/DebugHelper';

const describeBootstrapError = (error: unknown): string => {
  if (!(error instanceof Error)) return 'Harita yapılandırması yüklenemedi.';
  const diagnostic = error as Error & { code?: unknown; cause?: unknown };
  const code = typeof diagnostic.code === 'string' && /^[A-Z0-9_-]{1,48}$/.test(diagnostic.code) ? ` (${diagnostic.code})` : '';
  return `Harita yapılandırması yüklenemedi${code}. Lütfen bağlantınızı kontrol edip tekrar deneyin.`;
};
const SiteDataDisclaimer = () => (
  <aside aria-label="Veri kullanım uyarısı" className="position-fixed start-50 translate-middle-x px-3 py-2 rounded-3 border shadow-sm text-center fw-semibold" role="note" style={{bottom:'calc(8px + env(safe-area-inset-bottom))',zIndex:1004,maxWidth:'calc(100vw - 24px)',width:'max-content',pointerEvents:'none',backgroundColor:'var(--exp-surface)',borderColor:'var(--exp-border)',color:'var(--exp-text)',fontSize:'0.78rem',lineHeight:1.35}}>Sitede Gösterilen Veriler Bilgi Amaçlıdır. Resmî İşlemlerde <strong>KULLANILAMAZ!</strong></aside>
);
function App() {
  const windowManager = useWindowManager();
  const [configLoadStatus,setConfigLoadStatus]=useState<LoadingStatus>(Constants_LoadingStatus.LOADING);
  const [configErrorMessage,setConfigErrorMessage]=useState('');
  useEffect(()=>{const arcgisRuntime=configureArcgisModuleRuntime({version:AppConfig.App.EsriApiVersion,css:true,insertCssBefore:'link[rel="stylesheet"]'});const controller=new AbortController();const startedAt=performance.now();runtimeDiagnostics.record('app.bootstrap.started',{esriApiVersion:AppConfig.App.EsriApiVersion,arcgisModuleBackend:arcgisRuntime.backend,esriStylesheet:'managed-by-arcgis-module-runtime'});bootstrapApplication({signal:controller.signal}).then(()=>{if(controller.signal.aborted)return;runtimeDiagnostics.record('app.bootstrap.completed',{durationMs:Math.round(performance.now()-startedAt)});setConfigLoadStatus(Constants_LoadingStatus.COMPLETED);}).catch((error:unknown)=>{if(controller.signal.aborted||isBootstrapAbortError(error))return;DebugHelper.Log(error);runtimeDiagnostics.captureError(error,{source:'app.bootstrap',durationMs:Math.round(performance.now()-startedAt)});setConfigErrorMessage(describeBootstrapError(error));setConfigLoadStatus(Constants_LoadingStatus.ERROR);});return()=>controller.abort();},[]);
  return <ExperienceThemeProvider><ExperienceRuntimeBridge /><div id="app-shell">{configLoadStatus===Constants_LoadingStatus.LOADING?<FullScreenLoading />:configLoadStatus===Constants_LoadingStatus.ERROR?<FullScreenError message={configErrorMessage||'Harita yapılandırması yüklenemedi. Lütfen bağlantınızı kontrol edip sayfayı yenileyin.'}/>:<><MapComponent windowManager={windowManager}/><ExperienceWorkspace/><ExperienceUXLayer windowManager={windowManager}/><ExperienceCommandCenter windowManager={windowManager}/><SiteDataDisclaimer/></>}</div></ExperienceThemeProvider>;
}
export default App;
