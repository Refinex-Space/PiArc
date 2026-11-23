// T44 judges each metric's median in scripts/perf/run.mjs. A sample must first pass
// the same workload checks as T19, including the rate actually delivered to the app.
import { measureTranscript, test } from './transcript-measurement.js';

test('measures a valid Core transcript workload', async ({
  app,
  page,
  userDataDir,
  mock,
}, info) => {
  await measureTranscript({ app, page, userDataDir, mock }, info);
});
