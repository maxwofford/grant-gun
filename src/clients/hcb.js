const fs = require('fs')
const path = require('path')

class HCBClient {
  constructor(token) {
    this.token = token
    this.baseURL = 'https://hcb.hackclub.com/api/v4'
    this.headers = {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
    }
  }

  async fetchWithRetry(url, options, { retries = 5, quiet = false } = {}) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const response = await fetch(url, options)
      if (response.ok) return response
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        throw new Error(`${response.status} - ${response.statusText} (no access to this org: ${url})`)
      }
      if (attempt < retries) {
        const delay = 2000 * Math.pow(2, attempt - 1) // 2s, 4s, 8s, 16s
        if (!quiet) console.log(`   Request failed (${response.status}), retrying in ${delay / 1000}s (${attempt}/${retries - 1})...`)
        await new Promise((r) => setTimeout(r, delay))
      } else {
        throw new Error(`${response.status} - ${response.statusText}`)
      }
    }
  }

  async getOrgTransactions(eventId, type = 'disbursement', { quiet = false } = {}) {
    try {
      const url = `${this.baseURL}/organizations/${eventId}/transactions`
      const batchSize = 100
      const allTransactions = []
      let cursor = null
      let batchNum = 0

      if (!quiet) console.log(`   Fetching transactions with cursor-based pagination...`)

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

        const response = await this.fetchWithRetry(`${url}?${params.toString()}`, {
          headers: this.headers,
        }, { quiet })

        const data = await response.json()

        let transactions = []
        if (data && data.data && Array.isArray(data.data)) {
          transactions = data.data
        } else if (Array.isArray(data)) {
          transactions = data
        } else if (data && data.transactions && Array.isArray(data.transactions)) {
          transactions = data.transactions
        } else {
          throw new Error(`Unexpected response shape from HCB API (got ${typeof data}, keys: ${data ? Object.keys(data).join(', ') : 'null'})`)
        }

        allTransactions.push(...transactions)
        if (!quiet)
          console.log(
            `   Batch ${batchNum}: fetched ${transactions.length} (total: ${allTransactions.length})`
          )

        // Stop if no more pages
        if (data.has_more === false) {
          break
        }

        // Use the last transaction ID as cursor for next batch
        cursor = transactions[transactions.length - 1].id
      }

      if (!quiet) console.log(`   ✓ Fetched ${allTransactions.length} total transactions`)

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

  async getOrgBalance(eventId, { quiet = false } = {}) {
    const response = await this.fetchWithRetry(
      `${this.baseURL}/organizations/${eventId}`,
      { headers: this.headers },
      { quiet }
    )
    const data = await response.json()
    return data.balance_cents + (data.fee_balance_cents || 0)
  }

}

const CACHE_DIR = path.join(__dirname, '..', '..', '.cache', 'hcb')

function sumTransactionsCents(transactions) {
  return transactions.reduce((sum, tx) => {
    const amountCents = tx.amount_cents ? tx.amount_cents : Math.round((tx.amount || 0) * 100)
    return sum + amountCents
  }, 0)
}

function readCache(eventId) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${eventId}.json`), 'utf8'))
    return data.transactions
  } catch {
    return null
  }
}

function writeCache(eventId, transactions) {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(CACHE_DIR, `${eventId}.json`),
    JSON.stringify({ transactions }, null, 2)
  )
}

async function downloadTransactions(hcbClient, eventId, { quiet = false, maxAttempts = 3 } = {}) {
  const balanceCents = await hcbClient.getOrgBalance(eventId, { quiet })

  const cached = readCache(eventId)
  if (cached) {
    const cachedSum = sumTransactionsCents(cached)
    if (cachedSum === balanceCents) {
      if (!quiet) console.log(`   ✓ Balance verified from cache: $${(balanceCents / 100).toFixed(2)} (${cached.length} transactions)`)
      return cached
    }
    if (!quiet) console.log(`   Cache stale for ${eventId} (balance changed), re-fetching...`)
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const currentBalance = attempt === 1
      ? balanceCents
      : await hcbClient.getOrgBalance(eventId, { quiet })
    const transactions = await hcbClient.getOrgTransactions(eventId, null, { quiet })
    const computedBalanceCents = sumTransactionsCents(transactions)

    if (computedBalanceCents === currentBalance) {
      if (!quiet) console.log(`   ✓ Balance verified: $${(currentBalance / 100).toFixed(2)}`)
      writeCache(eventId, transactions)
      return transactions
    }

    if (!quiet) {
      console.log(
        `   ⚠ Balance mismatch for ${eventId} (attempt ${attempt}/${maxAttempts}): API says $${(currentBalance / 100).toFixed(2)}, transactions sum to $${(computedBalanceCents / 100).toFixed(2)}`
      )
    }
  }

  throw new Error(
    `Transaction data for ${eventId} failed balance verification after ${maxAttempts} attempts`
  )
}

function balanceBetweenOrgs(transactions, otherOrgSlugOrId) {
  const txMap = new Map()
  for (const tx of transactions) {
    txMap.set(tx.id, tx)
  }
  const uniqueTransactions = Array.from(txMap.values())

  const relevantTransfers = uniqueTransactions.filter((tx) => {
    const from = tx.transfer?.from
    const to = tx.transfer?.to
    const matchesOther =
      from?.slug === otherOrgSlugOrId ||
      from?.id === otherOrgSlugOrId ||
      to?.slug === otherOrgSlugOrId ||
      to?.id === otherOrgSlugOrId

    const excluded = tx.labels?.some((label) => label.name === 'no-grant-calc')

    return matchesOther && !excluded
  })

  const totalAmountCents = relevantTransfers.reduce((sum, tx) => {
    const amountCents = tx.amount_cents ? tx.amount_cents : Math.round((tx.amount || 0) * 100)
    return sum + amountCents
  }, 0)

  return { totalAmountCents, transferCount: relevantTransfers.length, transfers: relevantTransfers }
}

module.exports = { HCBClient, downloadTransactions, balanceBetweenOrgs }
