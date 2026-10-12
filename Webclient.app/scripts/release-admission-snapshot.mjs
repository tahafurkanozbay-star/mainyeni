import process from 'node:process';
export * from '../../quality/release/release-admission-snapshot.mts';
import { runReleaseAdmissionSnapshotCli } from '../../quality/release/release-admission-snapshot.mts';

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  if (!runReleaseAdmissionSnapshotCli(process.argv.slice(2))) process.exitCode = 1;
}
