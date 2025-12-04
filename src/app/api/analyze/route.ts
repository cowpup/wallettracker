import { NextRequest, NextResponse } from 'next/server'

const LAMPORTS_PER_SOL = 1_000_000_000
const HELIUS_API_KEY = '4d406aa7-10ef-48f8-8bc7-1e1a7a9c70eb'
const PARALLEL_WALLETS = 2 // Process 2 wallets in parallel
const BATCH_DELAY_MS = 250 // Wait 250ms between batches (~4-5 req/s)

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

interface HeliusTransaction {
  signature: string
  timestamp: number
  nativeTransfers: {
    fromUserAccount: string
    toUserAccount: string
    amount: number
  }[]
}

// Fetch current SOL price from CoinGecko
async function getSolPrice(): Promise<number> {
  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { next: { revalidate: 60 } }
    )
    if (!response.ok) return 0
    const data = await response.json()
    return data.solana?.usd || 0
  } catch {
    return 0
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Use Helius enhanced API - gets parsed transactions in ONE call
async function analyzeWalletHelius(
  walletAddress: string,
  maxTransactions: number,
  retryCount: number = 0
): Promise<WalletFlow> {
  try {
    // Helius enhanced transactions API - returns parsed data directly
    const url = `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=${Math.min(maxTransactions, 100)}`

    const response = await fetch(url)

    if (response.status === 429) {
      // Retry up to 3 times with increasing delay
      if (retryCount < 3) {
        await delay(1000 * (retryCount + 1)) // 1s, 2s, 3s
        return analyzeWalletHelius(walletAddress, maxTransactions, retryCount + 1)
      }
      return {
        address: walletAddress,
        totalInflowSol: 0,
        totalOutflowSol: 0,
        netFlowSol: 0,
        transactionCount: 0,
        firstTxTime: null,
        lastTxTime: null,
        error: 'Rate limited',
      }
    }

    if (!response.ok) {
      return {
        address: walletAddress,
        totalInflowSol: 0,
        totalOutflowSol: 0,
        netFlowSol: 0,
        transactionCount: 0,
        firstTxTime: null,
        lastTxTime: null,
        error: `API error: ${response.status}`,
      }
    }

    const transactions: HeliusTransaction[] = await response.json()

    if (!transactions || transactions.length === 0) {
      // No transactions is NOT an error - just an empty wallet
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

    for (const tx of transactions) {
      if (!tx.nativeTransfers) continue

      for (const transfer of tx.nativeTransfers) {
        if (transfer.toUserAccount === walletAddress) {
          totalInflow += transfer.amount
        }
        if (transfer.fromUserAccount === walletAddress) {
          totalOutflow += transfer.amount
        }
      }
    }

    const firstTxTime = transactions[transactions.length - 1]?.timestamp || null
    const lastTxTime = transactions[0]?.timestamp || null

    return {
      address: walletAddress,
      totalInflowSol: totalInflow / LAMPORTS_PER_SOL,
      totalOutflowSol: totalOutflow / LAMPORTS_PER_SOL,
      netFlowSol: (totalInflow - totalOutflow) / LAMPORTS_PER_SOL,
      transactionCount: transactions.length,
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

// Process wallets in parallel with rate limiting
async function processWalletsParallel(
  wallets: string[],
  maxTransactions: number
): Promise<WalletFlow[]> {
  const results: WalletFlow[] = []

  for (let i = 0; i < wallets.length; i += PARALLEL_WALLETS) {
    const chunk = wallets.slice(i, i + PARALLEL_WALLETS)
    const chunkResults = await Promise.all(
      chunk.map(wallet => analyzeWalletHelius(wallet, maxTransactions))
    )
    results.push(...chunkResults)

    // Wait between batches to respect rate limit (except for last batch)
    if (i + PARALLEL_WALLETS < wallets.length) {
      await delay(BATCH_DELAY_MS)
    }
  }

  return results
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { wallets, maxTransactions = 100 } = body

    if (!wallets || !Array.isArray(wallets) || wallets.length === 0) {
      return NextResponse.json(
        { error: 'Please provide an array of wallet addresses' },
        { status: 400 }
      )
    }

    if (wallets.length > 10000) {
      return NextResponse.json(
        { error: 'Maximum 10,000 wallets per request' },
        { status: 400 }
      )
    }

    // Fetch SOL price in parallel
    const [results, solPrice] = await Promise.all([
      processWalletsParallel(wallets, maxTransactions),
      getSolPrice(),
    ])

    const aggregate = {
      totalWallets: results.length,
      totalInflowSol: results.reduce((sum, r) => sum + r.totalInflowSol, 0),
      totalOutflowSol: results.reduce((sum, r) => sum + r.totalOutflowSol, 0),
      netFlowSol: results.reduce((sum, r) => sum + r.netFlowSol, 0),
      totalTransactions: results.reduce((sum, r) => sum + r.transactionCount, 0),
      errors: results.filter((r) => r.error).length,
    }

    return NextResponse.json({ results, aggregate, solPrice })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
