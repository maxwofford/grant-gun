#!/usr/bin/env bun

const { Command } = require('commander')
const inquirer = require('inquirer')
const open = require('open')
const { AirtableAuth } = require('./src/auth/airtable')
const { HCBAuth } = require('./src/auth/hcb')
const { AirtableClient } = require('./src/clients/airtable')
const { HCBClient, downloadTransactions, balanceBetweenOrgs } = require('./src/clients/hcb')
const c = require('./src/lib/colors')

// Config
const FINES_ACCOUNT_SLUG = 'fines' // HCB slug for the fines destination account

const program = new Command()

function renderProgressBar(completed, total, width = 30) {
  const percent = total > 0 ? completed / total : 0
  const filled = Math.round(width * percent)
  const empty = width - filled
  const bar = '█'.repeat(filled) + '░'.repeat(empty)
  return `[${bar}] ${completed}/${total}`
}

async function openTransferTab(eventId, transferAmount, programName, { refund = false } = {}) {
  const amountInCents = (Math.abs(transferAmount) * 100).toFixed(0)
  let message, url
  if (refund) {
    message = `Fine refund to ${programName} — $${Math.abs(transferAmount).toFixed(2)}`
    // Refunds flow FROM fines account TO the program
    url = `https://hcb.hackclub.com/disbursements/new?source_event_id=${FINES_ACCOUNT_SLUG}&event_id=${eventId}&amount=${amountInCents}&message=${encodeURIComponent(message)}`
  } else {
    message = `Fine for invalid WG payout — $${transferAmount.toFixed(2)}`
    // Fines flow FROM the program TO the fines account
    url = `https://hcb.hackclub.com/disbursements/new?source_event_id=${eventId}&event_id=${FINES_ACCOUNT_SLUG}&amount=${amountInCents}&message=${encodeURIComponent(message)}`
  }

  console.log(c.blue(`   🌐 Opening disbursement tab: ${url}`))

  try {
    await open(url)
    console.log(c.green(`   ✅ Opened disbursement page for ${programName}`))
  } catch (error) {
    console.log(c.red(`   ❌ Failed to open browser: ${error.message}`))
    console.log(c.blue(`   Please manually visit: ${url}`))
  }
}

async function processFinePayouts(programs, hcbClient, { dryRun = false } = {}) {
  console.log(c.blue('⚖️  Fine Payout Process'))
  if (dryRun) {
    console.log(c.yellow('🔍 Dry run mode - showing calculations only\n'))
  } else {
    console.log(c.gray('Review each program for fine collection approval. Use ? for help.\n'))
  }

  const approved = []
  const rejected = []
  let currentIndex = 0

  // Download all transactions from the fines account once, then look up per-program
  console.log(c.yellow('⚖️  Downloading transactions from fines account...'))
  let finesTransactions
  let finesStale = false
  try {
    finesTransactions = await downloadTransactions(hcbClient, FINES_ACCOUNT_SLUG, { quiet: false })
  } catch (err) {
    console.log(c.red(`⚠ Failed to fetch fines account transactions: ${err.message}`))
    console.log(c.red(`  All programs will be marked as stale\n`))
    finesTransactions = null
    finesStale = true
  }

  const programData = programs.map((prog) => {
    const programName = prog.fields['Name'] || 'Unknown Program'
    const totalFineAmount = prog.fields['Total Fine Amount'] || 0
    const targetAmount = totalFineAmount
    const hcbUrl = prog.fields['HCB']

    let org = null
    if (hcbUrl) {
      const urlParts = hcbUrl.split('/')
      const slug = urlParts[urlParts.length - 1]
      org = { eventId: slug, slug, name: slug.replace('ysws-budget-', '').replace('-', ' ') }
    }

    // Look up how much has already been collected from this program via the fines account transactions
    // From the fines account's perspective, receiving money from a program is positive
    let alreadyCollectedCents = 0
    if (!finesStale && org?.eventId) {
      const balance = balanceBetweenOrgs(finesTransactions, org.eventId)
      alreadyCollectedCents = balance.totalAmountCents // positive = fines account received
    }

    const targetAmountCents = Math.round(targetAmount * 100)
    const rawRemainingCents = targetAmountCents - alreadyCollectedCents
    const remainingCents = Math.max(0, rawRemainingCents)
    const transferAmount = remainingCents / 100
    const overCollectedAmount = rawRemainingCents < 0 ? Math.abs(rawRemainingCents) / 100 : 0

    return {
      program: prog,
      programName,
      totalFineAmount,
      targetAmount,
      hcbUrl,
      org,
      alreadyCollectedCents,
      transferAmount,
      overCollectedAmount,
      error: null,
      stale: finesStale,
    }
  })

  console.log(c.green(`✅ Transfer history query complete (${programs.length} programs)\n`))

  if (finesStale) {
    console.log(c.red(`⚠ Fines account data unavailable — all amounts may be wrong`))
    if (dryRun) {
      console.log(c.red(`  Consider re-running when HCB is stable\n`))
    } else {
      console.log(c.red(`  All programs will be auto-rejected — re-run when HCB is stable\n`))
    }
  }

  while (currentIndex < programData.length) {
    const data = programData[currentIndex]

    // Auto-skip stale, fully collected (no overage), or missing HCB data — but NOT over-collected
    const shouldSkip = data.stale || (!data.org || !data.org.eventId) || !data.hcbUrl ||
      (data.transferAmount <= 0 && data.overCollectedAmount <= 0)
    if (!dryRun && shouldSkip) {
      if (data.stale) {
        console.log(
          c.red(`⏭️  Skipping [${currentIndex + 1}/${programData.length}] ${data.programName}: HCB data unavailable`)
        )
      } else if (data.transferAmount <= 0) {
        console.log(
          c.yellow(`⏭️  Skipping [${currentIndex + 1}/${programData.length}] ${data.programName}: Already fully collected`)
        )
      } else if (!data.hcbUrl) {
        console.log(
          c.yellow(`⏭️  Skipping [${currentIndex + 1}/${programData.length}] ${data.programName}: Missing HCB URL`)
        )
      } else {
        console.log(
          c.yellow(`⏭️  Skipping [${currentIndex + 1}/${programData.length}] ${data.programName}: Missing HCB Event ID`)
        )
      }
      rejected.push(data)
      currentIndex++
      continue
    }

    console.log(c.cyan(`\n[${currentIndex + 1}/${programData.length}] ${data.programName}`))
    console.log(`   Total Fine Amount: $${data.totalFineAmount.toFixed(2)}`)
    console.log(`   Already Collected: $${(data.alreadyCollectedCents / 100).toFixed(2)}`)
    if (data.overCollectedAmount > 0) {
      console.log(`   ${c.yellow('Over-collected by: $' + data.overCollectedAmount.toFixed(2))}`)
    } else {
      console.log(`   ${c.bold('Remaining to Collect: $' + data.transferAmount.toFixed(2))}`)
    }
    console.log(`   HCB URL: ${data.hcbUrl || 'Not found'}`)
    console.log(`   Fines Account: ${FINES_ACCOUNT_SLUG}`)

    if (data.stale) {
      console.log(c.red(`   ⚠ HCB data unavailable — amounts are unreliable (${data.error || 'unknown error'})`))
    } else if (data.org) {
      console.log(`   HCB Event ID: ${data.org.eventId}`)
    } else if (data.error) {
      console.log(c.red(`   HCB Error: ${data.error}`))
    }

    if (dryRun) {
      currentIndex++
      continue
    }

    const { action } = await inquirer.prompt([
      {
        type: 'input',
        name: 'action',
        message: 'Approve this fine collection? (y)es, (n)o, (a)pprove all, (q)uit/reject all, (?) help:',
        validate: (input) => {
          const validOptions = ['y', 'yes', 'n', 'no', 'a', 'all', 'q', 'quit', '?', 'help']
          if (validOptions.includes(input.toLowerCase().trim())) return true
          return 'Please enter y, n, a, q, or ? for help'
        },
      },
    ])

    const choice = action.toLowerCase().trim()

    switch (choice) {
      case '?':
      case 'help':
        console.log(c.blue('\nAvailable commands:'))
        console.log('  y, yes     - Approve this fine collection and continue')
        console.log('  n, no      - Reject this fine collection and continue')
        console.log('  a, all     - Approve this and all remaining')
        console.log('  q, quit    - Reject this and all remaining')
        console.log('  ?          - Show this help message')
        continue

      case 'y':
      case 'yes':
        approved.push(data)
        console.log(c.green(`✅ Approved: Will collect $${data.transferAmount.toFixed(2)} from ${data.programName}`))
        currentIndex++
        break

      case 'n':
      case 'no':
        rejected.push(data)
        console.log(c.red(`❌ Rejected: ${data.programName}`))
        currentIndex++
        break

      case 'a':
      case 'all':
        for (let i = currentIndex; i < programData.length; i++) {
          const d = programData[i]
          approved.push(d)
          if (d.transferAmount > 0) {
            console.log(c.green(`✅ Approved: Will collect $${d.transferAmount.toFixed(2)} from ${d.programName}`))
          } else {
            console.log(c.green(`✅ Approved: No collection needed for ${d.programName}`))
          }
        }
        currentIndex = programData.length
        break

      case 'q':
      case 'quit':
        for (let i = currentIndex; i < programData.length; i++) {
          rejected.push(programData[i])
          console.log(c.red(`❌ Rejected: ${programData[i].programName}`))
        }
        currentIndex = programData.length
        break
    }
  }

  // Summary
  console.log(c.blue('\n📊 Summary:'))
  if (dryRun) {
    const stalePrograms = programData.filter((d) => d.stale)
    const needingCollection = programData.filter((d) => d.transferAmount > 0 && d.org?.eventId)
    const fullyCollected = programData.filter((d) => d.transferAmount <= 0 && d.overCollectedAmount <= 0)
    const overCollected = programData.filter((d) => d.overCollectedAmount > 0)
    const totalToCollect = needingCollection.reduce((sum, d) => sum + d.transferAmount, 0)
    const totalOver = overCollected.reduce((sum, d) => sum + d.overCollectedAmount, 0)
    if (stalePrograms.length > 0) {
      console.log(c.red(`\n⚠ ${stalePrograms.length} program(s) failed to fetch HCB data\n`))
    }
    console.log(`Total programs: ${programData.length}`)
    console.log(`Programs needing collection: ${needingCollection.length}`)
    console.log(`Programs fully collected: ${fullyCollected.length}`)
    console.log(`Programs over-collected: ${overCollected.length} ($${totalOver.toFixed(2)} total)`)
    console.log(`Total collection amount: $${totalToCollect.toFixed(2)}`)
    return
  }

  console.log(c.green(`✅ Approved: ${approved.length} programs`))
  console.log(c.red(`❌ Rejected: ${rejected.length} programs`))

  if (approved.length > 0) {
    const totalToCollect = approved.reduce((sum, d) => sum + d.transferAmount, 0)
    console.log(c.bold(`💰 Total collection amount: $${totalToCollect.toFixed(2)}`))

    console.log(c.blue('\n🌐 Opening transfer pages...'))
    for (const data of approved) {
      if (!data.org?.eventId) {
        console.log(c.yellow(`   ⚠️  Cannot open transfer for ${data.programName}: No HCB org found`))
      } else if (data.transferAmount > 0) {
        await openTransferTab(data.org.eventId, data.transferAmount, data.programName)
      } else if (data.overCollectedAmount > 0) {
        await openTransferTab(data.org.eventId, data.overCollectedAmount, data.programName, { refund: true })
      } else {
        console.log(c.yellow(`   ⚠️  Skipping ${data.programName}: No collection needed`))
      }
    }
  }
}

program
  .name('fine-payouts')
  .description('CLI tool for collecting fines for invalid WG payouts')
  .version('1.0.0')

program
  .command('run')
  .description('Process fine collections with approval workflow')
  .option('--program <name>', 'Filter to a specific program by HCB event ID or name')
  .option('--dry-run', 'Show calculations without interactive prompts or opening browser tabs')
  .option('--cache-auth', 'Cache OAuth tokens to skip re-authentication on subsequent runs')
  .action(async (options) => {
    try {
      console.log(c.blue('🚀 Starting Fine Collection workflow...\n'))

      console.log(c.yellow('📋 Validating Airtable credentials...'))
      const airtableAuth = new AirtableAuth()
      const airtableToken = await airtableAuth.authenticate()
      console.log(c.green('✅ Airtable credentials validated\n'))

      console.log(c.yellow('🏦 Authenticating with HCB...'))
      const hcbAuth = new HCBAuth({ cacheAuth: options.cacheAuth })
      const hcbToken = await hcbAuth.authenticate()
      console.log(c.green('✅ HCB authentication successful\n'))

      console.log(c.yellow('📊 Fetching programs from Airtable...'))
      const airtableClient = new AirtableClient(airtableToken)

      let filter = '{HCB} != ""'

      if (options.program) {
        const programValue = options.program
        filter = `AND({HCB} != "", OR(SEARCH("${programValue}", LOWER({HCB})), SEARCH("${programValue}", LOWER({Name}))))`
        console.log(c.blue(`🔍 Filtering for program matching: "${programValue}"`))
      }

      const eligiblePrograms = await airtableClient.fetchData(
        'app3A5kJwYqxMLOgh',
        'tblrGi9RARJy1A0c5',
        filter
      )

      console.log(c.green(`✅ Found ${eligiblePrograms.length} eligible program(s)\n`))

      if (eligiblePrograms.length === 0) {
        console.log(c.yellow('No programs found matching criteria.'))
        return
      }

      const hcbClient = new HCBClient(hcbToken)
      await processFinePayouts(eligiblePrograms, hcbClient, { dryRun: options.dryRun })
    } catch (error) {
      console.error(c.red(`❌ Error: ${error.message}`))
      process.exit(1)
    } finally {
      process.exit(0)
    }
  })

program.parse()
