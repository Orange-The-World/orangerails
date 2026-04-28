const express = require('express')
const blink = require('./adapters/blink')
const app = express()
app.use(express.json())

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'orangerails-api', version: '0.1.0' })
})

// POST /sync/blink
// Body: { api_key: string, cursor?: string }
// Returns: { transactions: OrangeTransaction[], next_cursor: string | null }
app.post('/sync/blink', async (req, res) => {
  const { api_key, cursor } = req.body
  if (!api_key) return res.status(400).json({ error: 'api_key required' })
  try {
    const result = await blink.sync(api_key, cursor)
    res.json(result)
  } catch (err) {
    res.status(502).json({ error: 'Blink sync failed', detail: err.message })
  }
})

const PORT = process.env.PORT || 3003
// Bind to all interfaces — when running in Docker, the compose port mapping
// (127.0.0.1:3003:3003) keeps the host port localhost-only.
app.listen(PORT, () => {
  console.log(`OrangeRails API listening on port ${PORT}`)
})
