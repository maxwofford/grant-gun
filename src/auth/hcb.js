const open = require('open')
const fs = require('fs')
const path = require('path')

const TOKEN_CACHE_PATH = path.join(__dirname, '..', '..', '.cache', 'hcb-token.json')

class HCBAuth {
  constructor({ cacheAuth = false } = {}) {
    this.clientId = process.env.HCB_APP_UID
    this.clientSecret = process.env.HCB_APP_SECRET
    this.redirectUri = process.env.HCB_REDIRECT_URI || 'http://localhost:3000'
    this.baseURL = 'https://hcb.hackclub.com/api/v4'
    this.server = null
    this.cacheAuth = cacheAuth
  }

  async authenticate() {
    if (this.cacheAuth) {
      const cached = this._readCachedToken()
      if (cached) {
        const valid = await this.validateToken(cached)
        if (valid) {
          console.log('Using cached HCB token')
          return cached
        }
        if (cached.refresh_token) {
          console.log('Cached HCB token expired, refreshing...')
          try {
            const refreshed = await this._refreshToken(cached.refresh_token)
            this._writeCachedToken(refreshed)
            console.log('Using refreshed HCB token')
            return refreshed
          } catch {
            console.log('Refresh failed, re-authenticating...')
          }
        } else {
          console.log('Cached HCB token expired, re-authenticating...')
        }
      }
    }

    const token = await this._oauthFlow()

    if (this.cacheAuth) {
      this._writeCachedToken(token)
    }

    return token
  }

  async _refreshToken(refreshToken) {
    const response = await fetch(`${this.baseURL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })
    if (!response.ok) throw new Error(`Refresh failed: ${response.status}`)
    return response.json()
  }

  _readCachedToken() {
    try {
      return JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, 'utf8'))
    } catch {
      return null
    }
  }

  _writeCachedToken(token) {
    fs.mkdirSync(path.dirname(TOKEN_CACHE_PATH), { recursive: true })
    fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(token, null, 2))
  }

  async _oauthFlow() {
    return new Promise((resolve, reject) => {
      let timeoutId

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

              clearTimeout(timeoutId)
              resolve(token)
              setTimeout(() => this.closeServer(), 500)

              return new Response(
                '<h1>✅ HCB authentication successful!</h1><p>You can close this window.</p>',
                { headers: { 'Content-Type': 'text/html' } }
              )
            } catch (error) {
              clearTimeout(timeoutId)
              reject(error)
              setTimeout(() => this.closeServer(), 500)

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
        `scope=admin:read`

      // Open browser
      console.log('Opening browser for HCB authentication...')
      console.log(`If browser doesn't open automatically, visit: ${authUrl}`)

      try {
        open(authUrl)
      } catch (error) {
        console.log('Could not open browser automatically. Please visit the URL above manually.')
      }

      // Timeout after 5 minutes
      timeoutId = setTimeout(() => {
        this.closeServer()
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
      this.server.stop(true)
      this.server = null
    }
  }
}

module.exports = { HCBAuth }
