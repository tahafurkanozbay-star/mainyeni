import process from 'node:process';
export * from '../../quality/release/release-candidate-gate.mts';
import { runReleaseCandidateCli } from '../../quality/release/release-candidate-gate.mts';

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  runReleaseCandidateCli();
}
