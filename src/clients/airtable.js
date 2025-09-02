class AirtableClient {
  constructor(token) {
    this.token = token
    this.baseURL = 'https://api.airtable.com/v0'
    this.headers = {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
    }
  }

  async fetchData(baseId = null, tableId = null) {
    try {
      // Use hardcoded base and table IDs
      const defaultBaseId = 'app3A5kJwYqxMLOgh'
      const defaultTableId = 'tblRf1BQs5H8298gW'

      baseId = baseId || defaultBaseId
      tableId = tableId || defaultTableId

      const url = `${this.baseURL}/${baseId}/${tableId}`
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

      // Transform records to a more usable format
      const transformedRecords = records.map((record) => ({
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
