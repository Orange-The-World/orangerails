const BLINK_API = 'https://api.blink.sv/graphql'

const TRANSACTIONS_QUERY = `
  query GetTransactions($after: String) {
    me {
      defaultAccount {
        wallets {
          id
          walletCurrency
          balance
          transactions(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                direction
                status
                memo
                createdAt
                settlementAmount
                settlementCurrency
                settlementFee
                initiationVia {
                  ... on InitiationViaLn { paymentHash }
                  ... on InitiationViaOnChain { address }
                }
              }
            }
          }
        }
      }
    }
  }
`

async function sync(apiKey, cursor = null) {
  const res = await fetch(BLINK_API, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: TRANSACTIONS_QUERY,
      variables: { after: cursor || null }
    })
  })

  if (!res.ok) throw new Error(`Blink HTTP ${res.status}`)
  const data = await res.json()
  if (data.errors) throw new Error(data.errors[0].message)

  const wallets = data.data.me.defaultAccount.wallets
  const transactions = []
  let nextCursor = null

  for (const wallet of wallets) {
    const { edges, pageInfo } = wallet.transactions
    if (pageInfo.hasNextPage) nextCursor = pageInfo.endCursor
    for (const { node: tx } of edges) {
      transactions.push(normalize(tx, wallet.walletCurrency))
    }
  }

  return { transactions, next_cursor: nextCursor }
}

function normalize(tx, walletCurrency) {
  const type = tx.initiationVia?.paymentHash ? 'lightning' : 'onchain'
  return {
    id: tx.id,
    adapter: 'blink',
    direction: tx.direction === 'RECEIVE' ? 'in' : 'out',
    type,
    amount_sats: Math.abs(tx.settlementAmount),
    currency: tx.settlementCurrency || walletCurrency,
    fee_sats: tx.settlementFee ?? 0,
    description: tx.memo ?? null,
    timestamp: tx.createdAt,
    status: tx.status,
    raw: tx
  }
}

module.exports = { sync }
