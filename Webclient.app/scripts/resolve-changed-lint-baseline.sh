#!/usr/bin/env bash
set -euo pipefail

event_name="${1:-}"
github_ref="${2:-}"

if [[ "$event_name" == "push" ]]; then
  if git -C .. rev-parse --is-shallow-repository | grep -qx true; then
    git -C .. fetch --no-tags --unshallow origin "$github_ref"
  else
    git -C .. fetch --no-tags origin "$github_ref"
  fi
  git -C .. fetch --no-tags origin main
  main_sha="$(git -C .. rev-parse FETCH_HEAD)"
  if base_sha="$(git -C .. merge-base "$main_sha" HEAD)" \
    && [[ -n "$base_sha" ]] \
    && git -C .. merge-base --is-ancestor "$base_sha" HEAD; then
    printf '%s\n' "$base_sha"
  else
    npm run lint:strict --if-present >&2
    git -C .. rev-parse HEAD
  fi
else
  npm run lint:strict --if-present >&2
  git -C .. rev-parse HEAD
fi
