const open = require('open')

class HCBAuth {
  constructor() {
    this.clientId = process.env.HCB_APP_UID
    this.clientSecret = process.env.HCB_APP_SECRET
    this.redirectUri = process.env.HCB_REDIRECT_URI || 'http://localhost:3000'
    this.baseURL = 'https://hcb.hackclub.com/api/v4'
    this.server = null // Store server reference
  }

  async authenticate() {
    // Always start fresh OAuth flow - no token storage
    return new Promise((resolve, reject) => {
      this.server = Bun.serve({
        port: 3000,
        fetch: async (req) => {
          const url = new URL(req.url)

          if (url.pathname === '/') {
            try {
              const code = url.searchParams.get('code')
              if (!code) {
                return new Response(
                  '<h1>❌ Authentication failed</h1><p>No authorization code received</p>',
                  { headers: { 'Content-Type': 'text/html' } }
                )
              }

              // Exchange code for token
              const tokenResponse = await fetch(`${this.baseURL}/oauth/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  client_id: this.clientId,
                  client_secret: this.clientSecret,
                  redirect_uri: this.redirectUri,
                  code: code,
                  grant_type: 'authorization_code',
                }),
              })

              const token = await tokenResponse.json()
              // Don't save token - always authenticate fresh

              this.server.stop()
              resolve(token)

              return new Response(
                '<h1>✅ HCB authentication successful!</h1><p>You can close this window.</p>',
                { headers: { 'Content-Type': 'text/html' } }
              )
            } catch (error) {
              this.server.stop()
              reject(error)

              return new Response(`<h1>❌ Authentication failed</h1><p>${error.message}</p>`, {
                headers: { 'Content-Type': 'text/html' },
              })
            }
          }

          return new Response('Not found', { status: 404 })
        },
      })

      // Generate authorization URL
      const authUrl =
        `${this.baseURL}/oauth/authorize?` +
        `client_id=${this.clientId}&` +
        `redirect_uri=${encodeURIComponent(this.redirectUri)}&` +
        `response_type=code&` +
        `scope=read`

      // Open browser
      console.log('Opening browser for HCB authentication...')
      console.log(`If browser doesn't open automatically, visit: ${authUrl}`)

      try {
        open(authUrl)
      } catch (error) {
        console.log('Could not open browser automatically. Please visit the URL above manually.')
      }

      // Timeout after 5 minutes
      setTimeout(() => {
        this.server.stop()
        reject(new Error('Authentication timeout'))
      }, 300000)
    })
  }

  async validateToken(token) {
    try {
      const response = await fetch(`${this.baseURL}/organizations`, {
        headers: {
          Authorization: `Bearer ${token.access_token}`,
        },
      })
      return response.ok
    } catch (error) {
      return false
    }
  }

  closeServer() {
    if (this.server) {
      this.server.stop()
      this.server = null
    }
  }
}

module.exports = { HCBAuth }
