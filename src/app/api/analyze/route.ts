import { NextRequest, NextResponse } from 'next/server'

const LAMPORTS_PER_SOL = 1_000_000_000
const MAX_RETRIES = 5
const BASE_DELAY_MS = 500
const REQUEST_DELAY_MS = 100 // Delay between consecutive requests

interface WalletFlow {
  address: string
  totalInflowSol: number
  totalOutflowSol: number
  netFlowSol: number
  transactionCount: number
  firstTxTime: number | null
  lastTxTime: number | null
  error?: string
}

// Helper to add delay between requests
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function rpcCall(rpcUrl: string, method: string, params: any[], retryCount = 0): Promise<any> {
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      }),
    })

    // Handle rate limiting with exponential backoff
    if (response.status === 429) {
      if (retryCount >= MAX_RETRIES) {
        throw new Error('Rate limit exceeded. Please use a dedicated RPC endpoint (Helius, QuickNode, etc.) or try again later.')
      }

      // Exponential backoff: 500ms, 1000ms, 2000ms, 4000ms, 8000ms
      const backoffDelay = BASE_DELAY_MS * Math.pow(2, retryCount)
      console.log(`Rate limited. Retrying in ${backoffDelay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`)
      await delay(backoffDelay)
      return rpcCall(rpcUrl, method, params, retryCount + 1)
    }

    if (!response.ok) {
      throw new Error(`RPC request failed: ${response.status}`)
    }

    return response.json()
  } catch (error) {
    // Retry on network errors
    if (retryCount < MAX_RETRIES && error instanceof TypeError) {
      const backoffDelay = BASE_DELAY_MS * Math.pow(2, retryCount)
      await delay(backoffDelay)
      return rpcCall(rpcUrl, method, params, retryCount + 1)
    }
    throw error
  }
}

async function getSignatures(rpcUrl: string, walletAddress: string, limit: number = 1000) {
  const allSignatures: any[] = []
  let before: string | undefined
  let isFirstRequest = true

  while (allSignatures.length < limit) {
    // Add delay between pagination requests (not on first request)
    if (!isFirstRequest) {
      await delay(REQUEST_DELAY_MS)
    }
    isFirstRequest = false

    const params: any[] = [
      walletAddress,
      { limit: Math.min(1000, limit - allSignatures.length) },
    ]
    if (before) {
      params[1].before = before
    }

    const result = await rpcCall(rpcUrl, 'getSignaturesForAddress', params)

    if (result.error) {
      throw new Error(`RPC Error: ${JSON.stringify(result.error)}`)
    }

    const signatures = result.result || []
    if (signatures.length === 0) break

    allSignatures.push(...signatures)
    before = signatures[signatures.length - 1].signature
  }

  return allSignatures
}

async function getTransaction(rpcUrl: string, signature: string) {
  const result = await rpcCall(rpcUrl, 'getTransaction', [
    signature,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
  ])

  if (result.error) return null
  return result.result
}

async function analyzeWallet(
  rpcUrl: string,
  walletAddress: string,
  maxTransactions: number = 200
): Promise<WalletFlow> {
  try {
    const signatures = await getSignatures(rpcUrl, walletAddress, maxTransactions)

    if (signatures.length === 0) {
      return {
        address: walletAddress,
        totalInflowSol: 0,
        totalOutflowSol: 0,
        netFlowSol: 0,
        transactionCount: 0,
        firstTxTime: null,
        lastTxTime: null,
      }
    }

    let totalInflow = 0
    let totalOutflow = 0
    let processed = 0

    const firstTxTime = signatures[signatures.length - 1]?.blockTime || null
    const lastTxTime = signatures[0]?.blockTime || null

    // Process transactions (limit to avoid timeout)
    const txsToProcess = signatures.slice(0, Math.min(maxTransactions, 100))

    for (let i = 0; i < txsToProcess.length; i++) {
      const sigInfo = txsToProcess[i]
      if (sigInfo.err) continue

      // Add delay between transaction fetches to avoid rate limiting
      if (i > 0) {
        await delay(REQUEST_DELAY_MS)
      }

      const tx = await getTransaction(rpcUrl, sigInfo.signature)
      if (!tx) continue

      const meta = tx.meta
      if (!meta) continue

      const preBalances = meta.preBalances || []
      const postBalances = meta.postBalances || []
      
      let accountKeys = tx.transaction?.message?.accountKeys || []
      if (accountKeys.length > 0 && typeof accountKeys[0] === 'object') {
        accountKeys = accountKeys.map((k: any) => k.pubkey || k)
      }

      const walletIndex = accountKeys.findIndex((k: string) => k === walletAddress)

      if (
        walletIndex !== -1 &&
        walletIndex < preBalances.length &&
        walletIndex < postBalances.length
      ) {
        const diff = postBalances[walletIndex] - preBalances[walletIndex]

        if (diff > 0) {
          totalInflow += diff
        } else {
          totalOutflow += Math.abs(diff)
        }
      }

      processed++
    }

    const inflowSol = totalInflow / LAMPORTS_PER_SOL
    const outflowSol = totalOutflow / LAMPORTS_PER_SOL

    return {
      address: walletAddress,
      totalInflowSol: inflowSol,
      totalOutflowSol: outflowSol,
      netFlowSol: inflowSol - outflowSol,
      transactionCount: processed,
      firstTxTime,
      lastTxTime,
    }
  } catch (error) {
    return {
      address: walletAddress,
      totalInflowSol: 0,
      totalOutflowSol: 0,
      netFlowSol: 0,
      transactionCount: 0,
      firstTxTime: null,
      lastTxTime: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { wallets, rpcUrl, maxTransactions = 100 } = body

    if (!wallets || !Array.isArray(wallets) || wallets.length === 0) {
      return NextResponse.json(
        { error: 'Please provide an array of wallet addresses' },
        { status: 400 }
      )
    }

    if (wallets.length > 10) {
      return NextResponse.json(
        { error: 'Maximum 10 wallets per request to avoid timeout' },
        { status: 400 }
      )
    }

    // Use provided RPC or default to public endpoint
    const rpc = rpcUrl || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'

    const results: WalletFlow[] = []

    for (let i = 0; i < wallets.length; i++) {
      // Add delay between wallet analyses to avoid rate limiting
      if (i > 0) {
        await delay(REQUEST_DELAY_MS * 2) // Slightly longer delay between wallets
      }
      const result = await analyzeWallet(rpc, wallets[i], maxTransactions)
      results.push(result)
    }

    // Calculate aggregates
    const aggregate = {
      totalWallets: results.length,
      totalInflowSol: results.reduce((sum, r) => sum + r.totalInflowSol, 0),
      totalOutflowSol: results.reduce((sum, r) => sum + r.totalOutflowSol, 0),
      netFlowSol: results.reduce((sum, r) => sum + r.netFlowSol, 0),
      totalTransactions: results.reduce((sum, r) => sum + r.transactionCount, 0),
      errors: results.filter((r) => r.error).length,
    }

    return NextResponse.json({ results, aggregate })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
