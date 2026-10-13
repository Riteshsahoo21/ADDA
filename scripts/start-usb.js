const { spawn } = require('node:child_process');

// On this Windows machine, plain localhost resolves to ::1. ADB reverse
// reaches 127.0.0.1, so make Metro bind IPv4 loopback only.
const nodeOptions = [process.env.NODE_OPTIONS, '--dns-result-order=ipv4first'].filter(Boolean).join(' ');
const child = spawn(process.execPath, [require.resolve('expo/bin/cli'), 'start', '--dev-client', '--localhost'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});

child.on('exit', (code) => { process.exitCode = code ?? 1; });
