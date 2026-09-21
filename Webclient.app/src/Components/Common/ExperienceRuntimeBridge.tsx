import { useEffect, type ReactNode } from "react";
import { createExperienceShellRuntime } from "../../experience/experienceShellRuntime";
import { runtimeDiagnostics } from "../../platform/runtime/runtimeDiagnostics";

const supportsExperienceMediaRuntime = (target: Window): boolean => typeof target.matchMedia === "function";

export const ExperienceRuntimeBridge = (): ReactNode => {
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined" || !supportsExperienceMediaRuntime(window)) return undefined;

    const runtime = createExperienceShellRuntime({
      window,
      document,
      reflectToDocument: true,
      onError: (error, source) => {
        runtimeDiagnostics.captureError(error, {
          source: `experience.shell.${source}`,
        });
      },
    });

    runtimeDiagnostics.record("experience.shell.started", {
      viewport: runtime.snapshot.workspace.policy.viewport,
      placement: runtime.snapshot.workspace.policy.placement,
      inputMode: runtime.snapshot.workspace.policy.inputMode,
      reducedMotion: runtime.snapshot.accessibility.reducedMotion,
      forcedColors: runtime.snapshot.accessibility.forcedColors,
    });

    const release = runtime.subscribe((snapshot, previous) => {
      if (
        snapshot.workspace.policy.viewport !== previous.workspace.policy.viewport
        || snapshot.workspace.policy.placement !== previous.workspace.policy.placement
        || snapshot.workspace.policy.inputMode !== previous.workspace.policy.inputMode
      ) {
        runtimeDiagnostics.record("experience.shell.layout.changed", {
          viewport: snapshot.workspace.policy.viewport,
          placement: snapshot.workspace.policy.placement,
          inputMode: snapshot.workspace.policy.inputMode,
        });
      }
    });

    return () => {
      release();
      runtime.dispose();
    };
  }, []);

  return null;
};

export default ExperienceRuntimeBridge;
