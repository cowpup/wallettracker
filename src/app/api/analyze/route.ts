import { NextRequest, NextResponse } from 'next/server'

const LAMPORTS_PER_SOL = 1_000_000_000
const MAX_RETRIES = 3
const BASE_DELAY_MS = 500
const PARALLEL_REQUESTS = 10 // Process 10 wallets in parallel

// Default RPC endpoint (Helius free tier)
const DEFAULT_RPC = 'https://mainnet.helius-rpc.com/?api-key=4d406aa7-10ef-48f8-8bc7-1e1a7a9c70eb'

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

    if (response.status === 429) {
      if (retryCount >= MAX_RETRIES) {
        throw new Error('Rate limited')
      }
      const backoffDelay = BASE_DELAY_MS * Math.pow(2, retryCount)
      await delay(backoffDelay)
      return rpcCall(rpcUrl, method, params, retryCount + 1)
    }

    if (!response.ok) {
      throw new Error(`RPC failed: ${response.status}`)
    }

    return response.json()
  } catch (error) {
    if (retryCount < MAX_RETRIES) {
      const backoffDelay = BASE_DELAY_MS * Math.pow(2, retryCount)
      await delay(backoffDelay)
      return rpcCall(rpcUrl, method, params, retryCount + 1)
    }
    throw error
  }
}

// Parallel RPC calls - fetch multiple transactions at once
async function parallelRpcCalls(
  rpcUrl: string,
  signatures: string[],
  concurrency: number = 10
): Promise<any[]> {
  const results: any[] = []

  for (let i = 0; i < signatures.length; i += concurrency) {
    const batch = signatures.slice(i, i + concurrency)
    const promises = batch.map(sig =>
      rpcCall(rpcUrl, 'getTransaction', [
        sig,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]).catch(() => ({ result: null }))
    )
    const batchResults = await Promise.all(promises)
    results.push(...batchResults)
  }

  return results
}

async function analyzeWalletFast(
  rpcUrl: string,
  walletAddress: string,
  maxTransactions: number
): Promise<WalletFlow> {
  try {
    // Step 1: Get signatures (just metadata, very fast)
    const sigResult = await rpcCall(rpcUrl, 'getSignaturesForAddress', [
      walletAddress,
      { limit: Math.min(maxTransactions, 1000) },
    ])

    if (sigResult.error) {
      throw new Error(sigResult.error.message || 'Failed to get signatures')
    }

    const signatures = sigResult.result || []

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

    const firstTxTime = signatures[signatures.length - 1]?.blockTime || null
    const lastTxTime = signatures[0]?.blockTime || null
    const validSignatures = signatures.filter((s: any) => !s.err).slice(0, maxTransactions)

    // Step 2: Fetch transactions in parallel (10 at a time)
    let totalInflow = 0
    let totalOutflow = 0
    let processed = 0

    const signatureStrings = validSignatures.map((s: any) => s.signature)
    const txResults = await parallelRpcCalls(rpcUrl, signatureStrings, 10)

    for (const txResult of txResults) {
      const tx = txResult?.result
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

    return {
      address: walletAddress,
      totalInflowSol: totalInflow / LAMPORTS_PER_SOL,
      totalOutflowSol: totalOutflow / LAMPORTS_PER_SOL,
      netFlowSol: (totalInflow - totalOutflow) / LAMPORTS_PER_SOL,
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

// Process wallets in parallel chunks
async function processWalletsParallel(
  rpcUrl: string,
  wallets: string[],
  maxTransactions: number,
  parallelCount: number
): Promise<WalletFlow[]> {
  const results: WalletFlow[] = []

  for (let i = 0; i < wallets.length; i += parallelCount) {
    const chunk = wallets.slice(i, i + parallelCount)
    const chunkResults = await Promise.all(
      chunk.map(wallet => analyzeWalletFast(rpcUrl, wallet, maxTransactions))
    )
    results.push(...chunkResults)
  }

  return results
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

    if (wallets.length > 10000) {
      return NextResponse.json(
        { error: 'Maximum 10,000 wallets per request' },
        { status: 400 }
      )
    }

    const rpc = rpcUrl || process.env.SOLANA_RPC_URL || DEFAULT_RPC

    // Fetch SOL price in parallel
    const [results, solPrice] = await Promise.all([
      processWalletsParallel(rpc, wallets, maxTransactions, PARALLEL_REQUESTS),
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
