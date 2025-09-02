const axios = require('axios')

class HCBClient {
  constructor(token) {
    this.token = token
    this.baseURL = 'https://hcb.hackclub.com/api/v4'
    this.headers = {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
    }
  }

  async getOrgTransactions(eventId, type = 'disbursement', limit = 100) {
    try {
      const url = `${this.baseURL}/organizations/${eventId}/transactions`
      const params = new URLSearchParams()

      params.append('limit', limit.toString())
      if (type) {
        params.append('type', type)
      }

      const response = await axios.get(`${url}?${params.toString()}`, { headers: this.headers })
      return response.data
    } catch (error) {
      throw new Error(
        `Failed to get org transactions: ${error.response?.status} - ${error.response?.statusText || error.message}`
      )
    }
  }

  async getOrgFromBudgetUrl(budgetUrl) {
    try {
      // Extract the budget slug from the URL (e.g., "ysws-budget-dhamari")
      const urlParts = budgetUrl.split('/')
      const budgetSlug = urlParts[urlParts.length - 1]

      // Use the slug directly as the event_id
      return {
        eventId: budgetSlug,
        slug: budgetSlug,
        name: budgetSlug.replace('ysws-budget-', '').replace('-', ' '),
      }
    } catch (error) {
      throw new Error(`Failed to get org from budget URL: ${error.message}`)
    }
  }

  async getTotalDisbursementsFromHQ(eventId) {
    try {
      const hqEventId = 183 // HQ org event ID

      // Get disbursements for this org
      const response = await this.getOrgTransactions(eventId, 'disbursement')

      // Handle different response structures
      let transactions = []
      if (Array.isArray(response)) {
        transactions = response
      } else if (response && response.data && Array.isArray(response.data)) {
        transactions = response.data
      } else if (response && response.transactions && Array.isArray(response.transactions)) {
        transactions = response.transactions
      } else {
        return {
          totalAmount: 0,
          disbursementCount: 0,
          disbursements: [],
          error: 'Unexpected API response structure',
        }
      }

      // Filter for disbursements from HQ (event_id 183)
      const hqDisbursements = transactions.filter(
        (tx) =>
          tx.from_event_id === hqEventId ||
          tx.from_organization_id === hqEventId ||
          (tx.memo && tx.memo.includes('HQ'))
      )

      // Sum up all disbursement amounts (convert from cents to dollars if needed)
      const totalDisbursed = hqDisbursements.reduce((sum, tx) => {
        const amount = tx.amount_cents ? tx.amount_cents / 100 : tx.amount || 0
        return sum + Math.abs(amount)
      }, 0)

      return {
        totalAmount: totalDisbursed,
        disbursementCount: hqDisbursements.length,
        disbursements: hqDisbursements,
      }
    } catch (error) {
      throw new Error(`Failed to get disbursements from HQ: ${error.message}`)
    }
  }
}

module.exports = { HCBClient }
