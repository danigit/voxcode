const esbuild = require('esbuild');
const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');

async function buildTests() {
  await esbuild.build({
    entryPoints: [
      'test/autoSpacer.test.ts',
      'test/token.test.ts',
      'test/client.test.ts',
      'test/clientStandalone.test.ts',
      'test/assetManager.test.ts',
      'test/processSupervisor.test.ts',
      'test/headlessDaemonIntegration.test.ts',
      'test/textDispatcher.test.ts',
      'test/focusTracker.test.ts',
      'test/cudaManager.test.ts',
    ],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outdir: 'out/test',
    alias: {
      vscode: path.resolve(__dirname, 'test/mockVscode.ts'),
    },
    sourcemap: 'inline',
  });

  const testDir = path.join(__dirname, 'out', 'test');
  const files = fs.readdirSync(testDir)
    .filter(f => f.endsWith('.test.js'))
    .map(f => path.join('out', 'test', f));
    
  console.log('Running node tests cross-platform...');
  const res = spawnSync('node', ['--test', ...files], { stdio: 'inherit' });
  if (res.status !== 0) {
    process.exit(res.status || 1);
  }
}

buildTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

