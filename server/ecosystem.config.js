module.exports = {
  apps: [{
    name: 'orangerails-api',
    script: 'server.js',
    cwd: '/home/orangerails',
    instances: 1,
    autorestart: true,
    watch: false,
    env: {
      NODE_ENV: 'production',
      PORT: 3003
    }
  }]
}
