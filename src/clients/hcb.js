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

      // First request to get total_count
      const firstParams = new URLSearchParams()
      firstParams.append('limit', batchSize.toString())
      firstParams.append('offset', '0')
      if (type) {
        firstParams.append('type', type)
      }

      console.log(`   Fetching first batch to determine total count...`)

      const firstResponse = await fetch(`${url}?${firstParams.toString()}`, {
        headers: this.headers,
      })

      if (!firstResponse.ok) {
        throw new Error(`${firstResponse.status} - ${firstResponse.statusText}`)
      }

      const firstData = await firstResponse.json()
      
      // Extract transactions and total count
      let firstTransactions = []
      let totalCount = 0
      
      if (firstData && firstData.data && Array.isArray(firstData.data)) {
        firstTransactions = firstData.data
        totalCount = firstData.total_count || firstTransactions.length
      } else if (Array.isArray(firstData)) {
        firstTransactions = firstData
        totalCount = firstTransactions.length
      } else if (firstData && firstData.transactions && Array.isArray(firstData.transactions)) {
        firstTransactions = firstData.transactions
        totalCount = firstTransactions.length
      }

      console.log(`   Total count: ${totalCount}, fetching remaining batches in parallel...`)

      // If we got everything in the first batch, return early
      if (totalCount <= batchSize) {
        return firstTransactions
      }

      // Calculate remaining batches to fetch in parallel
      const remainingBatches = []
      for (let offset = batchSize; offset < totalCount; offset += batchSize) {
        remainingBatches.push(offset)
      }

      console.log(`   Fetching ${remainingBatches.length} additional batches in parallel...`)

      // Fetch all remaining batches in parallel
      const batchPromises = remainingBatches.map(async (offset) => {
        const params = new URLSearchParams()
        params.append('limit', batchSize.toString())
        params.append('offset', offset.toString())
        if (type) {
          params.append('type', type)
        }

        const response = await fetch(`${url}?${params.toString()}`, {
          headers: this.headers,
        })

        if (!response.ok) {
          throw new Error(`${response.status} - ${response.statusText}`)
        }

        const data = await response.json()
        
        if (data && data.data && Array.isArray(data.data)) {
          return data.data
        } else if (Array.isArray(data)) {
          return data
        } else if (data && data.transactions && Array.isArray(data.transactions)) {
          return data.transactions
        }
        return []
      })

      const remainingResults = await Promise.all(batchPromises)
      const allTransactions = [firstTransactions, ...remainingResults].flat()

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
      const hqEventId = 183 // HQ org event ID

      // Get ALL disbursements for this org
      const transactions = await this.getOrgTransactions(eventId, 'disbursement')

      // Deduplicate by transaction ID/code using hashmap to prevent race conditions
      const txMap = new Map()
      for (const tx of transactions) {
        txMap.set(tx.id, tx)
      }

      const uniqueTransactions = Array.from(txMap.values())

      // Filter for disbursements from HQ (event_id 183)
      // Exclude transactions with 'no-grant-calc' label
      const hqDisbursements = uniqueTransactions.filter(
        (tx) =>
          (tx.from_event_id === hqEventId ||
          tx.from_organization_id === hqEventId ||
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
