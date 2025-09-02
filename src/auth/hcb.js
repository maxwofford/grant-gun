const express = require('express')
const axios = require('axios')
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
      const app = express()
      this.server = app.listen(3000)

      // Generate authorization URL
      const authUrl =
        `${this.baseURL}/oauth/authorize?` +
        `client_id=${this.clientId}&` +
        `redirect_uri=${encodeURIComponent(this.redirectUri)}&` +
        `response_type=code&` +
        `scope=read`

      app.get('/', async (req, res) => {
        try {
          const { code } = req.query
          if (!code) {
            throw new Error('No authorization code received')
          }

          // Exchange code for token
          const tokenResponse = await axios.post(`${this.baseURL}/oauth/token`, {
            client_id: this.clientId,
            client_secret: this.clientSecret,
            redirect_uri: this.redirectUri,
            code: code,
            grant_type: 'authorization_code',
          })

          const token = tokenResponse.data
          // Don't save token - always authenticate fresh

          res.send('<h1>✅ HCB authentication successful!</h1><p>You can close this window.</p>')
          this.server.close()
          resolve(token)
        } catch (error) {
          res.send(`<h1>❌ Authentication failed</h1><p>${error.message}</p>`)
          this.server.close()
          reject(error)
        }
      })

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
        this.server.close()
        reject(new Error('Authentication timeout'))
      }, 300000)
    })
  }

  async validateToken(token) {
    try {
      const response = await axios.get(`${this.baseURL}/organizations`, {
        headers: {
          Authorization: `Bearer ${token.access_token}`,
        },
      })
      return response.status === 200
    } catch (error) {
      return false
    }
  }

  closeServer() {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }
}

module.exports = { HCBAuth }
