const { expect } = require('chai')
const { BigNumber, utils, providers, Wallet } = require('ethers')
const { ethers } = require('hardhat')
const { Bridge, OutGoingMessageState } = require('arb-ts')
const yargs = require('yargs/yargs')

require('dotenv').config()

const wait = (ms = 0) => {
  return new Promise(res => setTimeout(res, ms || 10000))
}

/**
 * Set up: User provides a transaction hash
 * Txn hash should of a txn that triggered an outgoing message (i.e., ArbSys.sendTxToL1)
 */

// TODO command line args
const txnHash =
  '0x688d4ead30173aac1191b7b39c25e341e685cdc1f178398f7c955041b183cba0'

if (!txnHash)
  throw new Error(
    'Provide a transaction hash of an L2 transaction that sends an L2 to L1 message'
  )
console.warn(txnHash.length)
if (!txnHash.startsWith('0x') || txnHash.length != 34)
  throw new Error(`Hmm, ${txnHash} doesn't look like a txn hash...`)

/**
 * Set up: instantiate L1 / L2 wallets connected to providers
 */
const infuraKey = process.env.INFURA_KEY
if (!infuraKey) throw new Error('No INFURA_KEY set.')

const walletPrivateKey = process.env.DEVNET_PRIVKEY
if (!walletPrivateKey) throw new Error('No DEVNET_PRIVKEY set.')

const l1Provider = new providers.JsonRpcProvider(process.env.L1RPC)
const l2Provider = new providers.JsonRpcProvider(process.env.L2RPC)

const l1Wallet = new Wallet(walletPrivateKey, l1Provider)
const l2Wallet = new Wallet(walletPrivateKey, l2Provider)

const main = async () => {
  /**
   * Use wallets to create an arb-ts bridge instance
   * We'll use bridge for its convenience methods around outbox-execution
   */
  const bridge = await Bridge.init(l1Wallet, l2Wallet)

  /**
   * First, let's find the Arbitrum txn from the txn hash provided
   */
  const initiatingTxnReceipt = await bridge.l2Provider.getTransactionReceipt(
    txnHash
  )

  if (!initiatingTxnReceipt)
    throw new Error(
      `No Arbitrum transaction found with provided txn hash: ${txnHash}`
    )

  /**
   * In order to trigger the outbox message, we'll first need the outgoing messages batch number and index; together these two things uniquely identify an outgoing message.
   * To get this data, we'll use getWithdrawalsInL2Transaction, which retrieves this data from the L2 events logs
   */

  const outGoingMessagesFromTxn = await bridge.getWithdrawalsInL2Transaction(
    initiatingTxnReceipt
  )

  if (outGoingMessagesFromTxn.length === 0)
    throw new Error(`Txn ${txnHash} did not initate an outgoing messages`)

  /**
   * Note that in principle, a single transaction could trigger any number of outgoing messages; the common case will be there's only one.
   * For the sake of this script, we assume there's only one / just grad the first one.
   */
  const { batchNumber, indexInBatch } = outGoingMessagesFromTxn[0]

  /**
   * We've got batchNumber and IndexInBatch in hand; but before we try to execute out message, we need to make sure it's confirmed! (It can only be confirmed after he dispute period; Arbitrum is an optimistic rollup after-all)
   * Here we'll do a period check; once getOutgoingMessageState tells us our txn is confirm, we'll move on to execution
   */
  const outgoingMessageState = await bridge.getOutgoingMessageState(
    batchNumber,
    indexInBatch
  )
  console.log(
    `Waiting for message to be confirmed: Batchnumber: ${batchNumber}, IndexInBatch ${indexInBatch}`
  )

  while (!outgoingMessageState === OutGoingMessageState.CONFIRMED) {
    await wait(1000 * 60)
    const outgoingMessageState = await bridge.getOutgoingMessageState(
      batchNumber,
      indexInBatch
    )

    switch (outgoingMessageState) {
      case OutGoingMessageState.NOT_FOUND: {
        console.log('Message not found; something strange and bad happened')
        process.exit(1)
        break
      }
      case OutGoingMessageState.EXECUTED: {
        console.log(`Message already executed! Nothing else to do here`)
        process.exit(1)
        break
      }
      case OutGoingMessageState.UNCONFIRMED: {
        console.log(`Message not yet confirmed; we'll wait a bit and try again`)
        break
      }

      default:
        break
    }
  }

  console.log('Transaction confirmed! Trying to execute now')
  /**
   * Now that its confirmed, we can retrieve the Merkle proof data from the chain, and execute our message in its outbox entry.
   * triggerL2ToL1Transaction handles these steps
   */
  const res = await bridge.triggerL2ToL1Transaction(batchNumber, indexInBatch)
  const rec = await res.wait()

  console.log('Done! Your transaction is executed')
}
main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
