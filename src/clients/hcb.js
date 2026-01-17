class HCBClient {
  constructor(token) {
    this.token = token
    this.baseURL = 'https://hcb.hackclub.com/api/v4'
    this.headers = {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
    }
  }

  async getOrgTransactions(eventId, type = 'disbursement') {
    try {
      const url = `${this.baseURL}/organizations/${eventId}/transactions`
      const batchSize = 1000
      const allTransactions = []
      let cursor = null
      let batchNum = 0

      console.log(`   Fetching transactions with cursor-based pagination...`)

      while (true) {
        batchNum++
        const params = new URLSearchParams()
        params.append('limit', batchSize.toString())
        if (type) {
          params.append('type', type)
        }
        if (cursor) {
          params.append('after', cursor)
        }

        const response = await fetch(`${url}?${params.toString()}`, {
          headers: this.headers,
        })

        if (!response.ok) {
          throw new Error(`${response.status} - ${response.statusText}`)
        }

        const data = await response.json()

        let transactions = []
        if (data && data.data && Array.isArray(data.data)) {
          transactions = data.data
        } else if (Array.isArray(data)) {
          transactions = data
        } else if (data && data.transactions && Array.isArray(data.transactions)) {
          transactions = data.transactions
        }

        allTransactions.push(...transactions)
        console.log(`   Batch ${batchNum}: fetched ${transactions.length} (total: ${allTransactions.length})`)

        // Stop if no more pages
        if (data.has_more === false) {
          break
        }

        // Use the last transaction ID as cursor for next batch
        cursor = transactions[transactions.length - 1].id
      }

      console.log(`   ✓ Fetched ${allTransactions.length} total transactions`)

      return allTransactions
    } catch (error) {
      throw new Error(`Failed to get org transactions: ${error.message}`)
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
      const hqOrgId = 'org_a29uVj' // HQ org ID
      const hqSlug = 'hq' // HQ org slug

      // Get ALL transactions for this org (no type filter - we filter for HQ transfers below)
      const transactions = await this.getOrgTransactions(eventId, null)

      // Deduplicate by transaction ID/code using hashmap to prevent race conditions
      const txMap = new Map()
      for (const tx of transactions) {
        txMap.set(tx.id, tx)
      }

      const uniqueTransactions = Array.from(txMap.values())

      // Filter for disbursements from HQ
      // Check nested transfer.from.slug or transfer.from.id
      // Exclude transactions with 'no-grant-calc' label
      const hqDisbursements = uniqueTransactions.filter(
        (tx) =>
          (tx.transfer?.from?.slug === hqSlug ||
          tx.transfer?.from?.id === hqOrgId ||
          (tx.memo && tx.memo.includes('HQ'))) &&
          (!tx.labels || !tx.labels.some(label => label.name === 'no-grant-calc'))
      )

      // Sum up all disbursement amounts in cents (integer math)
      const totalDisbursedCents = hqDisbursements.reduce((sum, tx) => {
        const amountCents = tx.amount_cents ? tx.amount_cents : Math.round((tx.amount || 0) * 100)
        return sum + Math.abs(amountCents)
      }, 0)

      return {
        totalAmountCents: totalDisbursedCents,
        disbursementCount: hqDisbursements.length,
        disbursements: hqDisbursements,
      }
    } catch (error) {
      throw new Error(`Failed to get disbursements from HQ: ${error.message}`)
    }
  }
}

module.exports = { HCBClient }
