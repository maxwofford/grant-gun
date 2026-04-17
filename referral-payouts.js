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
const REFERRAL_BONUS_AMOUNT = 50 // $50 per weighted referral
const REFERRAL_SOURCE_SLUG = '2026-03-16-referrals' // HCB slug for the referral bonus source account
const REFERRAL_FLOAT_AMOUNT = 1000 // Keep $1000 float in the referral account

const program = new Command()

async function openTransferTab(eventId, transferAmount, programName) {
  const referralCount = transferAmount / REFERRAL_BONUS_AMOUNT
  const message = `Referral bonus for ${referralCount.toFixed(1)} weighted referrals`
  const amountInCents = (transferAmount * 100).toFixed(0)
  const url = `https://hcb.hackclub.com/disbursements/new?source_event_id=${REFERRAL_SOURCE_SLUG}&event_id=${eventId}&amount=${amountInCents}&message=${encodeURIComponent(message)}`

  console.log(c.blue(`   🌐 Opening disbursement tab: ${url}`))

  try {
    await open(url)
    console.log(c.green(`   ✅ Opened disbursement page for ${programName}`))
  } catch (error) {
    console.log(c.red(`   ❌ Failed to open browser: ${error.message}`))
    console.log(c.blue(`   Please manually visit: ${url}`))
  }
}

async function processReferralPayouts(programs, hcbClient, { dryRun = false } = {}) {
  console.log(c.blue('🎁 Referral Payout Process'))
  if (dryRun) {
    console.log(c.yellow('🔍 Dry run mode - showing calculations only\n'))
  } else {
    console.log(c.gray('Review each program for referral payout approval. Use ? for help.\n'))
  }

  const approved = []
  const rejected = []
  let currentIndex = 0

  // Download all transactions from the referral account once, then look up per-program
  console.log(c.yellow('🎁 Downloading transactions from referral account...'))
  let referralTransactions
  let referralStale = false
  try {
    referralTransactions = await downloadTransactions(hcbClient, REFERRAL_SOURCE_SLUG, { quiet: false })
  } catch (err) {
    console.log(c.red(`⚠ Failed to fetch referral account transactions: ${err.message}`))
    console.log(c.red(`  All programs will be marked as stale\n`))
    referralTransactions = null
    referralStale = true
  }

  const programData = programs.map((prog) => {
    const programName = prog.fields['Name'] || 'Unknown Program'
    const referralCount = prog.fields['Weighted Referral Count'] || 0
    const targetAmount = referralCount * REFERRAL_BONUS_AMOUNT
    const hcbUrl = prog.fields['HCB']

    let org = null
    if (hcbUrl) {
      const urlParts = hcbUrl.split('/')
      const slug = urlParts[urlParts.length - 1]
      org = { eventId: slug, slug, name: slug.replace('ysws-budget-', '').replace('-', ' ') }
    }

    // Look up how much has already been sent to this program from the referral account
    // From the referral account's perspective, sending money to a program is negative
    let alreadyTransferredCents = 0
    if (!referralStale && org?.eventId) {
      const balance = balanceBetweenOrgs(referralTransactions, org.eventId)
      alreadyTransferredCents = -balance.totalAmountCents // negate: outflows are negative from referral's view
    }

    const targetAmountCents = Math.round(targetAmount * 100)
    const rawTransferAmountCents = targetAmountCents - alreadyTransferredCents
    const transferAmountCents = Math.max(0, rawTransferAmountCents)
    const transferAmount = transferAmountCents / 100
    const overDisbursedAmount =
      rawTransferAmountCents < 0 ? Math.abs(rawTransferAmountCents) / 100 : 0

    return {
      program: prog,
      programName,
      referralCount,
      targetAmount,
      hcbUrl,
      org,
      alreadyTransferredCents,
      transferAmount,
      overDisbursedAmount,
      error: null,
      stale: referralStale,
    }
  })

  console.log(c.green(`✅ Transfer history query complete (${programs.length} programs)\n`))

  if (referralStale) {
    console.log(c.red(`⚠ Referral account data unavailable — all amounts may be wrong`))
    if (dryRun) {
      console.log(c.red(`  Consider re-running when HCB is stable\n`))
    } else {
      console.log(c.red(`  All programs will be auto-rejected — re-run when HCB is stable\n`))
    }
  }

  const staleCount = programData.filter((d) => d.stale).length
  if (staleCount > 0) {
    console.log(c.red(`⚠ ${staleCount} program(s) failed to fetch HCB data — their amounts may be wrong`))
    if (dryRun) {
      console.log(c.red(`  Consider re-running when HCB is stable\n`))
    } else {
      console.log(c.red(`  They will be auto-rejected — re-run when HCB is stable\n`))
    }
  }

  while (currentIndex < programData.length) {
    const data = programData[currentIndex]

    if (!dryRun && (data.stale || data.transferAmount <= 0 || !data.org || !data.org.eventId)) {
      if (data.stale) {
        console.log(
          c.red(`⏭️  Skipping [${currentIndex + 1}/${programData.length}] ${data.programName}: HCB data unavailable`)
        )
      } else if (data.transferAmount <= 0) {
        if (data.overDisbursedAmount > 0) {
          console.log(
            c.yellow(`⏭️  Skipping [${currentIndex + 1}/${programData.length}] ${data.programName}: Over-disbursed by $${data.overDisbursedAmount.toFixed(2)}`)
          )
        } else {
          console.log(
            c.yellow(`⏭️  Skipping [${currentIndex + 1}/${programData.length}] ${data.programName}: Already fully disbursed`)
          )
        }
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
    console.log(`   Weighted Referral Count: ${data.referralCount}`)
    console.log(`   Target Amount: $${data.targetAmount.toFixed(2)} (${data.referralCount} × $${REFERRAL_BONUS_AMOUNT})`)
    console.log(`   Already Transferred: $${(data.alreadyTransferredCents / 100).toFixed(2)}`)
    if (data.overDisbursedAmount > 0) {
      console.log(`   ${c.yellow('Over-disbursed by: $' + data.overDisbursedAmount.toFixed(2))}`)
    } else {
      console.log(`   ${c.bold('Transfer Amount: $' + data.transferAmount.toFixed(2))}`)
    }
    console.log(`   HCB URL: ${data.hcbUrl || 'Not found'}`)
    console.log(`   Source Account: ${REFERRAL_SOURCE_SLUG}`)

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
        message: 'Approve this referral payout? (y)es, (n)o, (a)pprove all, (q)uit/reject all, (?) help:',
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
        console.log('  y, yes     - Approve this referral payout and continue')
        console.log('  n, no      - Reject this referral payout and continue')
        console.log('  a, all     - Approve this and all remaining')
        console.log('  q, quit    - Reject this and all remaining')
        console.log('  ?          - Show this help message')
        continue

      case 'y':
      case 'yes':
        approved.push(data)
        console.log(c.green(`✅ Approved: Will transfer $${data.transferAmount.toFixed(2)} to ${data.programName}`))
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
            console.log(c.green(`✅ Approved: Will transfer $${d.transferAmount.toFixed(2)} to ${d.programName}`))
          } else {
            console.log(c.green(`✅ Approved: No transfer needed for ${d.programName}`))
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
    const needingTransfer = programData.filter((d) => d.transferAmount > 0 && d.org?.eventId)
    const fullyDisbursed = programData.filter((d) => d.transferAmount <= 0 && d.overDisbursedAmount <= 0)
    const overDisbursed = programData.filter((d) => d.overDisbursedAmount > 0)
    const totalToTransfer = needingTransfer.reduce((sum, d) => sum + d.transferAmount, 0)
    const totalOver = overDisbursed.reduce((sum, d) => sum + d.overDisbursedAmount, 0)
    if (stalePrograms.length > 0) {
      console.log(c.red(`\n⚠ ${stalePrograms.length} program(s) failed to fetch HCB data\n`))
    }
    console.log(`Total programs: ${programData.length}`)
    console.log(`Programs needing transfer: ${needingTransfer.length}`)
    console.log(`Programs fully disbursed: ${fullyDisbursed.length}`)
    console.log(`Programs over-disbursed: ${overDisbursed.length} ($${totalOver.toFixed(2)} total)`)
    console.log(`Total transfer amount: $${totalToTransfer.toFixed(2)}`)

    // Show top-up calculation
    try {
      const balanceCents = await hcbClient.getOrgBalance(REFERRAL_SOURCE_SLUG, { quiet: true })
      const balance = balanceCents / 100
      const topUp = Math.max(0, totalToTransfer + REFERRAL_FLOAT_AMOUNT - balance)
      console.log(`\nReferral account balance: $${balance.toFixed(2)}`)
      console.log(`Top-up needed (payouts + $${REFERRAL_FLOAT_AMOUNT} float - balance): $${topUp.toFixed(2)}`)
    } catch (err) {
      console.log(c.red(`\n⚠ Could not fetch referral account balance: ${err.message}`))
    }
    return
  }

  console.log(c.green(`✅ Approved: ${approved.length} programs`))
  console.log(c.red(`❌ Rejected: ${rejected.length} programs`))

  if (approved.length > 0) {
    const totalToTransfer = approved.reduce((sum, d) => sum + d.transferAmount, 0)
    console.log(c.bold(`💰 Total transfer amount: $${totalToTransfer.toFixed(2)}`))

    // Open HQ → referral account top-up tab first
    try {
      const balanceCents = await hcbClient.getOrgBalance(REFERRAL_SOURCE_SLUG, { quiet: true })
      const balance = balanceCents / 100
      const topUp = Math.max(0, totalToTransfer + REFERRAL_FLOAT_AMOUNT - balance)
      console.log(`\n   Referral account balance: $${balance.toFixed(2)}`)

      if (topUp > 0) {
        const topUpCents = (topUp * 100).toFixed(0)
        const message = `Top-up referral bonus account ($${totalToTransfer.toFixed(2)} payouts + $${REFERRAL_FLOAT_AMOUNT} float)`
        const url = `https://hcb.hackclub.com/disbursements/new?source_event_id=hq&event_id=${REFERRAL_SOURCE_SLUG}&amount=${topUpCents}&message=${encodeURIComponent(message)}`
        console.log(c.blue(`\n🏦 Opening HQ → referral account top-up: $${topUp.toFixed(2)}`))
        try {
          await open(url)
          console.log(c.green(`   ✅ Opened top-up disbursement page`))
        } catch (err) {
          console.log(c.red(`   ❌ Failed to open browser: ${err.message}`))
          console.log(c.blue(`   Please manually visit: ${url}`))
        }
      } else {
        console.log(c.green(`   ✅ Referral account already has enough ($${balance.toFixed(2)}) — no top-up needed`))
      }
    } catch (err) {
      console.log(c.red(`\n   ⚠ Could not fetch referral account balance: ${err.message}`))
      console.log(c.yellow(`   Skipping top-up — you may need to top up manually`))
    }

    console.log(c.blue('\n🌐 Opening transfer pages...'))
    for (const data of approved) {
      if (data.org?.eventId && data.transferAmount > 0) {
        await openTransferTab(data.org.eventId, data.transferAmount, data.programName)
      } else if (data.transferAmount <= 0) {
        console.log(c.yellow(`   ⚠️  Skipping ${data.programName}: No transfer needed`))
      } else {
        console.log(c.yellow(`   ⚠️  Cannot open transfer for ${data.programName}: No HCB org found`))
      }
    }
  }
}

program
  .name('referral-payouts')
  .description('CLI tool for calculating referral bonus payouts')
  .version('1.0.0')

program
  .command('run')
  .description('Process referral payouts with approval workflow')
  .option('--program <name>', 'Filter to a specific program by HCB event ID or name')
  .option('--dry-run', 'Show calculations without interactive prompts or opening browser tabs')
  .option('--cache-auth', 'Cache OAuth tokens to skip re-authentication on subsequent runs')
  .action(async (options) => {
    try {
      console.log(c.blue('🚀 Starting Referral Payout workflow...\n'))

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

      let filter = 'AND({Weighted Referral Count} > 0, {Enable payouts} = TRUE(), {HCB} != "")'

      if (options.program) {
        const programValue = options.program
        filter = `AND({Weighted Referral Count} > 0, {Enable payouts} = TRUE(), {HCB} != "", OR(SEARCH("${programValue}", LOWER({HCB})), SEARCH("${programValue}", LOWER({Name}))))`
        console.log(c.blue(`🔍 Filtering for program matching: "${programValue}"`))
      }

      let eligiblePrograms
      try {
        eligiblePrograms = await airtableClient.fetchData(
          'app3A5kJwYqxMLOgh',
          'tblrGi9RARJy1A0c5',
          filter
        )
      } catch (error) {
        console.log(c.yellow('⚠️  "Enable payouts" field not found. Falling back without it.'))
        let fallbackFilter = 'AND({Weighted Referral Count} > 0, {HCB} != "")'
        if (options.program) {
          const programValue = options.program
          fallbackFilter = `AND({Weighted Referral Count} > 0, {HCB} != "", OR(SEARCH("${programValue}", LOWER({HCB})), SEARCH("${programValue}", LOWER({Name}))))`
        }
        eligiblePrograms = await airtableClient.fetchData(
          'app3A5kJwYqxMLOgh',
          'tblrGi9RARJy1A0c5',
          fallbackFilter
        )
      }

      console.log(c.green(`✅ Found ${eligiblePrograms.length} eligible program(s)\n`))

      if (eligiblePrograms.length === 0) {
        console.log(c.yellow('No programs found matching criteria.'))
        return
      }

      const hcbClient = new HCBClient(hcbToken)
      await processReferralPayouts(eligiblePrograms, hcbClient, { dryRun: options.dryRun })
    } catch (error) {
      console.error(c.red(`❌ Error: ${error.message}`))
      process.exit(1)
    } finally {
      process.exit(0)
    }
  })

program.parse()
