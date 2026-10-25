// PM2 process file. Run one instance: the recovery loop and booking locks expect a single long-running process.
module.exports = {
  apps: [{
    name: 'booking-calendar',
    script: 'dist/server.js',
    cwd: __dirname,
    exec_mode: 'fork',
    instances: 1,
    env: { NODE_ENV: 'production' },
    max_memory_restart: '300M',
    // The server waits up to 20 s to finish in-flight bookings on shutdown.
    kill_timeout: 25000
  }]
};
