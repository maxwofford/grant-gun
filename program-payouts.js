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

async function openTransferTab(eventId, transferAmount, programName) {
  const weightedGrants = transferAmount / 85 // Each weighted grant is $85
  const message = `Program payout for ${weightedGrants.toFixed(1)} weighted grants`
  const amountInCents = (transferAmount * 100).toFixed(0) // Convert to cents, no decimals
  const url = `https://hcb.hackclub.com/disbursements/new?source_event_id=hq&event_id=${eventId}&amount=${amountInCents}&message=${encodeURIComponent(message)}`

  console.log(chalk.blue(`   🌐 Opening disbursement tab: ${url}`))

  try {
    await open(url)
    console.log(chalk.green(`   ✅ Opened disbursement page for ${programName}`))
  } catch (error) {
    console.log(chalk.red(`   ❌ Failed to open browser: ${error.message}`))
    console.log(chalk.blue(`   Please manually visit: ${url}`))
  }
}

async function processProgramPayouts(programs, hcbClient) {
  console.log(chalk.blue('💰 Program Payout Process'))
  console.log(chalk.gray('Review each program for payout approval. Use ? for help.\n'))

  const approved = []
  const rejected = []
  let currentIndex = 0
  
  // Collect all program data with HCB info first
  console.log(chalk.yellow('💰 Querying HCB transfer history for programs...'))
  const programData = []
  
  for (const program of programs) {
    const programName = program.fields['Name'] || 'Unknown Program'
    const weightedTotal = program.fields['Weighted–Total'] || 0
    const targetAmount = weightedTotal * 85 // Each weighted grant is $85
    const hcbUrl = program.fields['HCB']
    
    let org = null
    let disbursementData = { totalAmountCents: 0, disbursementCount: 0 }
    let error = null
    
    if (hcbUrl) {
      try {
        org = await hcbClient.getOrgFromBudgetUrl(hcbUrl)
        
        if (org.eventId) {
          disbursementData = await hcbClient.getTotalDisbursementsFromHQ(org.eventId)
        }
      } catch (err) {
        error = err.message
      }
    }
    
    const targetAmountCents = Math.round(targetAmount * 100)
    const rawTransferAmountCents = targetAmountCents - disbursementData.totalAmountCents
    const transferAmountCents = Math.max(0, rawTransferAmountCents)
    const transferAmount = transferAmountCents / 100
    const overDisbursedAmount = rawTransferAmountCents < 0 ? Math.abs(rawTransferAmountCents) / 100 : 0

    programData.push({
      program,
      programName,
      weightedTotal,
      targetAmount,
      hcbUrl,
      org,
      disbursementData,
      transferAmount,
      overDisbursedAmount,
      error
    })
  }
  
  console.log(chalk.green(`✅ Transfer history query complete\n`))

  while (currentIndex < programData.length) {
    const data = programData[currentIndex]
    
    // Auto-skip $0 transfers and missing HCB URLs
    if (data.transferAmount <= 0 || !data.org || !data.org.eventId) {
      if (data.transferAmount <= 0) {
        if (data.overDisbursedAmount > 0) {
          console.log(chalk.yellow(`⏭️  Skipping [${currentIndex + 1}/${programData.length}] ${data.programName}: Over-disbursed by $${data.overDisbursedAmount.toFixed(2)}`))
        } else {
          console.log(chalk.yellow(`⏭️  Skipping [${currentIndex + 1}/${programData.length}] ${data.programName}: Already fully disbursed`))
        }
      } else if (!data.hcbUrl) {
        console.log(chalk.yellow(`⏭️  Skipping [${currentIndex + 1}/${programData.length}] ${data.programName}: Missing HCB URL`))
      } else if (!data.org || !data.org.eventId) {
        console.log(chalk.yellow(`⏭️  Skipping [${currentIndex + 1}/${programData.length}] ${data.programName}: Missing HCB Event ID`))
      }
      rejected.push(data)
      currentIndex++
      continue
    }

    // Display program information
    console.log(chalk.cyan(`\n[${currentIndex + 1}/${programData.length}] ${data.programName}`))
    console.log(`   Weighted Total: ${data.weightedTotal}`)
    console.log(`   Target Amount: $${data.targetAmount.toFixed(2)}`)
    console.log(`   Total Disbursements from HQ: $${(data.disbursementData.totalAmountCents / 100).toFixed(2)} (${data.disbursementData.disbursementCount} disbursements)`)
    console.log(`   ${chalk.bold('Transfer Amount: $' + data.transferAmount.toFixed(2))}`)
    console.log(`   HCB URL: ${data.hcbUrl || 'Not found'}`)
    
    if (data.org) {
      console.log(`   HCB Event ID: ${data.org.eventId}`)
    } else if (data.error) {
      console.log(chalk.red(`   HCB Error: ${data.error}`))
    }

    const { action } = await inquirer.prompt([
      {
        type: 'input',
        name: 'action',
        message: 'Approve this program payout? (y)es, (n)o, (a)pprove all, (q)uit/reject all, (?) help:',
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
        console.log('  y, yes     - Approve this program payout and continue')
        console.log('  n, no      - Reject this program payout and continue')
        console.log('  a, all     - Approve this program and all remaining programs')
        console.log('  q, quit    - Reject this program and all remaining programs')
        console.log('  ?          - Show this help message')
        continue // Don't advance index, show same program again

      case 'y':
      case 'yes':
        approved.push(data)
        if (data.transferAmount > 0) {
          console.log(chalk.green(`✅ Approved: Will transfer $${data.transferAmount.toFixed(2)} to ${data.programName}`))
        } else {
          console.log(chalk.green(`✅ Approved: No transfer needed for ${data.programName}`))
        }
        currentIndex++
        break

      case 'n':
      case 'no':
        rejected.push(data)
        console.log(chalk.red(`❌ Rejected: ${data.programName}`))
        currentIndex++
        break

      case 'a':
      case 'all':
        // Approve current and all remaining
        for (let i = currentIndex; i < programData.length; i++) {
          const remainingData = programData[i]
          approved.push(remainingData)
          if (remainingData.transferAmount > 0) {
            console.log(chalk.green(`✅ Approved: Will transfer $${remainingData.transferAmount.toFixed(2)} to ${remainingData.programName}`))
          } else {
            console.log(chalk.green(`✅ Approved: No transfer needed for ${remainingData.programName}`))
          }
        }
        currentIndex = programData.length // Exit loop
        break

      case 'q':
      case 'quit':
        // Reject current and all remaining
        for (let i = currentIndex; i < programData.length; i++) {
          const remainingData = programData[i]
          rejected.push(remainingData)
          console.log(chalk.red(`❌ Rejected: ${remainingData.programName}`))
        }
        currentIndex = programData.length // Exit loop
        break
    }
  }

  // Summary
  console.log(chalk.blue('\n📊 Summary:'))
  console.log(chalk.green(`✅ Approved: ${approved.length} programs`))
  console.log(chalk.red(`❌ Rejected: ${rejected.length} programs`))

  if (approved.length > 0) {
    const totalToTransfer = approved.reduce((sum, data) => sum + data.transferAmount, 0)
    console.log(chalk.bold(`💰 Total transfer amount: $${totalToTransfer.toFixed(2)}`))

    // Open transfer tabs for all approved programs with transfer amounts > 0
    console.log(chalk.blue('\n🌐 Opening transfer pages...'))
    for (const data of approved) {
      if (data.org && data.org.eventId && data.transferAmount > 0) {
        await openTransferTab(data.org.eventId, data.transferAmount, data.programName)
      } else if (data.transferAmount <= 0) {
        console.log(chalk.yellow(`   ⚠️  Skipping ${data.programName}: No transfer needed`))
      } else {
        console.log(chalk.yellow(`   ⚠️  Cannot open transfer for ${data.programName}: ${data.org ? 'No event ID' : 'No HCB org found'}`))
      }
    }
    
    // Summary of transfers
    console.log(chalk.blue('\n📋 Transfer Summary:'))
    approved.forEach(data => {
      const status = (data.org && data.org.eventId && data.transferAmount > 0) ? '✅' : (data.transferAmount <= 0 ? '⏭️' : '❌')
      let statusText
      if (data.overDisbursedAmount > 0) {
        statusText = `(Over-disbursed by $${data.overDisbursedAmount.toFixed(2)})`
      } else if (data.transferAmount <= 0) {
        statusText = '(Fully disbursed)'
      } else if (data.org) {
        statusText = `(Event: ${data.org.eventId})`
      } else {
        statusText = '(No HCB event)'
      }
      console.log(`${status} ${data.programName}: $${data.transferAmount.toFixed(2)} ${statusText}`)
    })
  }
}

program
  .name('program-payouts')
  .description('CLI tool for calculating program-level payouts')
  .version('1.0.0')

program
  .command('run')
  .description('Process program payouts with approval workflow')
  .option('--program <name>', 'Filter to a specific program by HCB event ID or name')
  .action(async (options) => {
    try {
      console.log(chalk.blue('🚀 Starting Program Payout workflow...\n'))

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
      console.log(chalk.yellow('📊 Fetching programs from Airtable...'))
      const airtableClient = new AirtableClient(airtableToken)
      
      // Build base filter
      let filter = "AND({Weighted–Total} > 0, {Enable payouts} = TRUE())"
      
      // Add program filter if specified
      if (options.program) {
        const programValue = options.program
        filter = `AND({Weighted–Total} > 0, {Enable payouts} = TRUE(), OR(SEARCH("${programValue}", LOWER({HCB})), SEARCH("${programValue}", LOWER({Name}))))`
        console.log(chalk.blue(`🔍 Filtering for program matching: "${programValue}"`))
      }
      
      let eligiblePrograms
      try {
        eligiblePrograms = await airtableClient.fetchData(
          'app3A5kJwYqxMLOgh', 
          'tblrGi9RARJy1A0c5',
          filter
        )
      } catch (error) {
        console.log(chalk.yellow('⚠️  "Enable payouts" field not found. Falling back to weighted total filter.'))
        console.log(chalk.yellow('   Add an "Enable payouts" checkbox field to the Programs table for better control.'))
        
        // Fallback filter
        let fallbackFilter = '{Weighted–Total} > 0'
        if (options.program) {
          const programValue = options.program
          fallbackFilter = `AND({Weighted–Total} > 0, OR(SEARCH("${programValue}", LOWER({HCB})), SEARCH("${programValue}", LOWER({Name}))))`
        }
        
        eligiblePrograms = await airtableClient.fetchData(
          'app3A5kJwYqxMLOgh', 
          'tblrGi9RARJy1A0c5',
          fallbackFilter
        )
      }

      console.log(chalk.green(`✅ Found ${eligiblePrograms.length} eligible program(s)\n`))

      if (eligiblePrograms.length === 0) {
        console.log(chalk.yellow('No programs found matching criteria.'))
        return
      }

      // Step 4: Initialize HCB client
      const hcbClient = new HCBClient(hcbToken)

      // Step 5: Interactive approval process
      await processProgramPayouts(eligiblePrograms, hcbClient)

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
