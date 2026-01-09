class AirtableClient {
  constructor(token) {
    this.token = token
    this.baseURL = 'https://api.airtable.com/v0'
    this.headers = {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
    }
  }

  async fetchData(baseId = null, tableId = null, filter = null) {
    try {
      // Use hardcoded base and table IDs
      const defaultBaseId = 'app3A5kJwYqxMLOgh'
      const defaultTableId = 'tblRf1BQs5H8298gW'

      baseId = baseId || defaultBaseId
      tableId = tableId || defaultTableId

      let allRecords = []
      let offset = null

      do {
        let url = `${this.baseURL}/${baseId}/${tableId}`
        const params = new URLSearchParams()
        
        // Add filter if provided
        if (filter) {
          params.append('filterByFormula', filter)
        }
        
        // Add offset for pagination
        if (offset) {
          params.append('offset', offset)
        }
        
        if (params.toString()) {
          url += `?${params.toString()}`
        }
        
        const response = await fetch(url, { headers: this.headers })

        if (!response.ok) {
          const errorData = await response.json()
          throw new Error(
            `Airtable API error: ${response.status} - ${
              errorData.error?.message || response.statusText
            }`
          )
        }

        const data = await response.json()
        const records = data.records || []
        
        // Add records to our collection
        allRecords = allRecords.concat(records)
        
        // Check if there are more pages
        offset = data.offset
        
      } while (offset)

      // Transform records to a more usable format
      const transformedRecords = allRecords.map((record) => ({
        id: record.id,
        createdTime: record.createdTime,
        fields: record.fields,
      }))

      return transformedRecords
    } catch (error) {
      throw new Error(`Failed to fetch Airtable data: ${error.message}`)
    }
  }
}

module.exports = { AirtableClient }
