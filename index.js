#!/usr/bin/env bun

const { Command } = require('commander')
const chalk = require('chalk')
const inquirer = require('inquirer')
const open = require('open')
const { AirtableAuth } = require('./src/auth/airtable')
const { HCBAuth } = require('./src/auth/hcb')
const { AirtableClient } = require('./src/clients/airtable')
const { HCBClient } = require('./src/clients/hcb')

const program = new Command()

async function openDisbursementTab(eventId, transferAmount, recipientName) {
  const weightedGrants = transferAmount / 85 // Each weighted grant is $85
  const message = `for ${weightedGrants.toFixed(1)} weighted grants`
  const amountInCents = (transferAmount * 100).toFixed(0) // Convert to cents, no decimals
  const url = `https://hcb.hackclub.com/disbursements/new?source_event_id=hq&event_id=${eventId}&amount=${amountInCents}&message=${encodeURIComponent(message)}`

  console.log(chalk.blue(`   🌐 Opening disbursement tab: ${url}`))

  try {
    await open(url)
    console.log(chalk.green(`   ✅ Opened disbursement page for ${recipientName}`))
  } catch (error) {
    console.log(chalk.red(`   ❌ Failed to open browser: ${error.message}`))
    console.log(chalk.blue(`   Please manually visit: ${url}`))
  }
}

async function processGrantApprovals(orgData) {
  console.log(chalk.blue('📋 Grant Approval Process'))
  console.log(chalk.gray('Review each grant for approval. Use ? for help.\n'))

  const approved = []
  const rejected = []
  let currentIndex = 0

  while (currentIndex < orgData.length) {
    const org = orgData[currentIndex]
    const transferAmount = org.weightedGrantsAmount - org.disbursementData.totalAmount
    const orgName = org.org.slug ? org.org.slug.replace('ysws-budget-', '') : org.name

    // Display org information
    console.log(chalk.cyan(`\n[${currentIndex + 1}/${orgData.length}] ${org.name}`))
    console.log(`   HCB Event ID: ${org.org.eventId || 'Unknown'}`)
    console.log(`   USD for Weighted Grants: $${org.formattedAmount}`)
    console.log(
      `   Total Disbursements from HQ: $${org.disbursementData.totalAmount.toFixed(2)} (${org.disbursementData.disbursementCount} disbursements)`
    )
    console.log(`   ${chalk.bold('Transfer Amount: $' + transferAmount.toFixed(2))}`)

    if (org.error) {
      console.log(chalk.red(`   Error: ${org.error}`))
    }

    if (transferAmount <= 0) {
      console.log(
        chalk.yellow(`   ⚠️  No transfer needed (already fully disbursed or over-disbursed)`)
      )
    }

    const { action } = await inquirer.prompt([
      {
        type: 'input',
        name: 'action',
        message: 'Approve this grant? (y)es, (n)o, (a)pprove all, (q)uit/reject all, (?) help:',
        validate: (input) => {
          const validOptions = ['y', 'yes', 'n', 'no', 'a', 'all', 'q', 'quit', '?', 'help']
          if (validOptions.includes(input.toLowerCase().trim())) {
            return true
          }
          return 'Please enter y, n, a, q, or ? for help'
        },
      },
    ])

    const choice = action.toLowerCase().trim()

    switch (choice) {
      case '?':
      case 'help':
        console.log(chalk.blue('\nAvailable commands:'))
        console.log('  y, yes     - Approve this grant and continue')
        console.log('  n, no      - Reject this grant and continue')
        console.log('  a, all     - Approve this grant and all remaining grants')
        console.log('  q, quit    - Reject this grant and all remaining grants')
        console.log('  ?          - Show this help message')
        continue // Don't advance index, show same org again

      case 'y':
      case 'yes':
        approved.push(org)
        if (transferAmount > 0) {
          console.log(
            chalk.green(`✅ Approved: Will transfer $${transferAmount.toFixed(2)} to ${orgName}`)
          )
        } else {
          console.log(chalk.green(`✅ Approved: No transfer needed for ${orgName}`))
        }
        currentIndex++
        break

      case 'n':
      case 'no':
        rejected.push(org)
        console.log(chalk.red(`❌ Rejected: ${orgName}`))
        currentIndex++
        break

      case 'a':
      case 'all':
        // Approve current and all remaining
        for (let i = currentIndex; i < orgData.length; i++) {
          const remainingOrg = orgData[i]
          const remainingTransferAmount =
            remainingOrg.weightedGrantsAmount - remainingOrg.disbursementData.totalAmount
          const remainingOrgName = remainingOrg.org.slug
            ? remainingOrg.org.slug.replace('ysws-budget-', '')
            : remainingOrg.name

          approved.push(remainingOrg)
          if (remainingTransferAmount > 0) {
            console.log(
              chalk.green(
                `✅ Approved: Will transfer $${remainingTransferAmount.toFixed(2)} to ${remainingOrgName}`
              )
            )
          } else {
            console.log(chalk.green(`✅ Approved: No transfer needed for ${remainingOrgName}`))
          }
        }
        currentIndex = orgData.length // Exit loop
        break

      case 'q':
      case 'quit':
        // Reject current and all remaining
        for (let i = currentIndex; i < orgData.length; i++) {
          const remainingOrg = orgData[i]
          const remainingOrgName = remainingOrg.org.slug
            ? remainingOrg.org.slug.replace('ysws-budget-', '')
            : remainingOrg.name
          rejected.push(remainingOrg)
          console.log(chalk.red(`❌ Rejected: ${remainingOrgName}`))
        }
        currentIndex = orgData.length // Exit loop
        break
    }
  }

  // Summary
  console.log(chalk.blue('\n📊 Summary:'))
  console.log(chalk.green(`✅ Approved: ${approved.length} grants`))
  console.log(chalk.red(`❌ Rejected: ${rejected.length} grants`))

  if (approved.length > 0) {
    const totalToTransfer = approved.reduce((sum, org) => {
      const transferAmount = Math.max(
        0,
        org.weightedGrantsAmount - org.disbursementData.totalAmount
      )
      return sum + transferAmount
    }, 0)
    console.log(chalk.bold(`💰 Total transfer amount: $${totalToTransfer.toFixed(2)}`))

    // Open disbursement tabs for all approved grants with transfer amounts > 0
    console.log(chalk.blue('\n🌐 Opening disbursement pages...'))
    for (const org of approved) {
      const transferAmount = org.weightedGrantsAmount - org.disbursementData.totalAmount
      const orgName = org.org.slug ? org.org.slug.replace('ysws-budget-', '') : org.name

      if (transferAmount > 0) {
        await openDisbursementTab(org.org.eventId, transferAmount, orgName)
      }
    }
  }
}

program
  .name('grant-gun')
  .description('CLI tool for OAuth with Airtable and HCB, data sync, and automated transfers')
  .version('1.0.0')

program
  .command('run')
  .description('Execute the grant workflow: auth, fetch data, and display records')
  .action(async () => {
    try {
      console.log(chalk.blue('🚀 Starting Grant Gun workflow...\n'))

      // Step 1: Authenticate with Airtable
      console.log(chalk.yellow('📋 Validating Airtable credentials...'))
      const airtableAuth = new AirtableAuth()
      const airtableToken = await airtableAuth.authenticate()
      console.log(chalk.green('✅ Airtable credentials validated\n'))

      // Step 2: Authenticate with HCB
      console.log(chalk.yellow('🏦 Authenticating with HCB...'))
      const hcbAuth = new HCBAuth()
      const hcbToken = await hcbAuth.authenticate()
      console.log(chalk.green('✅ HCB authentication successful\n'))

      // Step 3: Fetch data from Airtable
      console.log(chalk.yellow('📊 Fetching data from Airtable...'))
      const airtableClient = new AirtableClient(airtableToken)
      const allRecords = await airtableClient.fetchData()

      // Filter records where HCB Budget Fund is not blank
      const validRecords = allRecords.filter(
        (record) =>
          record.fields['HCB Budget Fund'] && record.fields['HCB Budget Fund'].trim() !== ''
      )

      console.log(chalk.green(`✅ Found ${validRecords.length} records with HCB Budget Fund\n`))

      if (validRecords.length === 0) {
        console.log(chalk.yellow('No records found with HCB Budget Fund values.'))
        return
      }

      // Step 4: Initialize HCB client to query transfer data
      console.log(chalk.yellow('💰 Querying HCB transfer history...'))
      const hcbClient = new HCBClient(hcbToken)

      // Collect all org data first
      const orgData = []

      for (let i = 0; i < validRecords.length; i++) {
        const record = validRecords[i]
        const weightedGrantsAmount = record.fields['USD for Weighted Grants']
        const formattedAmount = weightedGrantsAmount
          ? Number(weightedGrantsAmount).toFixed(2)
          : '0.00'

        try {
          const org = await hcbClient.getOrgFromBudgetUrl(record.fields['HCB Budget Fund'])
          let disbursementData = { totalAmount: 0, disbursementCount: 0 }

          if (org.eventId) {
            disbursementData = await hcbClient.getTotalDisbursementsFromHQ(org.eventId)
          }

          orgData.push({
            record,
            org,
            weightedGrantsAmount: parseFloat(formattedAmount),
            formattedAmount,
            disbursementData,
            name: record.fields['Name'] || org.name,
          })
        } catch (error) {
          orgData.push({
            record,
            org: { eventId: null, name: 'Unknown' },
            weightedGrantsAmount: parseFloat(formattedAmount),
            formattedAmount,
            disbursementData: { totalAmount: 0, disbursementCount: 0 },
            name: record.fields['Name'] || 'Unknown',
            error: error.message,
          })
        }
      }

      console.log(chalk.green(`✅ Transfer history query complete\n`))

      // Interactive approval process
      await processGrantApprovals(orgData)
    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`))
      process.exit(1)
    } finally {
      process.exit(0)
    }
  })

program
  .command('auth')
  .description('Test authentication with both services')
  .action(async () => {
    let hcbAuth
    try {
      console.log(chalk.blue('🔐 Testing authentication...\n'))

      const airtableAuth = new AirtableAuth()
      await airtableAuth.authenticate()
      console.log(chalk.green('✅ Airtable credentials validated'))

      hcbAuth = new HCBAuth()
      await hcbAuth.authenticate()
      console.log(chalk.green('✅ HCB authentication successful'))
    } catch (error) {
      console.error(chalk.red(`❌ Authentication failed: ${error.message}`))
    } finally {
      // Ensure server is closed
      if (hcbAuth) {
        hcbAuth.closeServer()
      }
      process.exit(0)
    }
  })

program.parse()
