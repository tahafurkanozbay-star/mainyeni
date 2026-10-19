# Archived GIS experience policies

This directory preserves the former `WebClient/src/gis/` policy modules as a frozen reference set. The original tree contained 62 TypeScript files and about 650 KB of policy/test code.

## Why archived

A repository audit found no `WebClient` package manifest or TypeScript project configuration, no active GitHub Actions workflow/path filter building or testing this tree, and no reference from the active `Webclient.app/` or `KentRehberi/webclient/` composition roots. Current platform module/language boundary tools explicitly scope their analysis to `Webclient.app/src/`. The policies use relative imports within their own subtree, so the original internal relationships have been preserved.

These files were moved rather than deleted. They are not included in the static SPA build, deployment output, active CI suite, or current application module graph.

## Rules

- Do not add this directory to a TypeScript build root, Vite alias, package entrypoint, or CI gate simply to make the old code appear active.
- Do not edit these frozen copies as though they were the live application implementation.
- Reuse/reintegration requires a concrete product requirement, an explicit adapter/migration plan, license/content review as applicable, and focused lint/typecheck/Vitest regression coverage.
- The actively tested GIS core tree remains `KentRehberi/webclient/`; the deployable web application remains `Webclient.app/`.
