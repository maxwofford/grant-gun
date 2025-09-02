class AirtableAuth {
  constructor() {
    this.pat = process.env.AIRTABLE_PAT
    if (!this.pat) {
      throw new Error('AIRTABLE_PAT environment variable is required')
    }
  }

  async authenticate() {
    // For PAT, we just need to validate the token
    const isValid = await this.validateToken()
    if (!isValid) {
      throw new Error('Invalid Airtable Personal Access Token')
    }

    return {
      access_token: this.pat,
      token_type: 'pat',
    }
  }

  async validateToken() {
    try {
      const response = await fetch('https://api.airtable.com/v0/meta/whoami', {
        headers: {
          Authorization: `Bearer ${this.pat}`,
        },
      })
      return response.ok
    } catch (error) {
      return false
    }
  }
}

module.exports = { AirtableAuth }
