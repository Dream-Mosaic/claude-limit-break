import { defineConfig } from '@vscode/test-cli';

// Integration tests run inside a real VS Code, downloaded on first use. They
// are named *.itest.ts so the unit suite's `out/test/**/*.test.js` glob does not
// pick them up - the two runners are separate on purpose. The unit tests are
// fast and run against a fake `vscode`; these are slow and prove the extension
// actually activates against the real API.
export default defineConfig({
  files: 'out/test/integration/**/*.itest.js',
  mocha: {
    // Matches the ui the VS Code extension templates use.
    ui: 'tdd',
    // Downloading and booting VS Code is slow on a cold CI runner.
    timeout: 60000,
  },
});
