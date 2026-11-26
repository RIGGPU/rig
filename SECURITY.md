# Security policy

RIG holds balances and moves money, so reports about either are taken first.

## How to report

Open a [private vulnerability report](https://github.com/RIGGPU/rig/security/advisories/new) on this repository with steps to reproduce and what you saw. Expect an acknowledgement inside 72 hours and a fix or a written assessment inside 14 days.

## What counts

- Credits that appear without a payment, or a payment counted twice
- One wallet reading, spending or refunding another wallet's balance
- An API key spending past its cap, working after it is stopped, or doing something reserved for the wallet
- An x402 authorization accepted with the wrong amount, recipient, signer or time window, or accepted twice
- A flaw in `server/evm.js`: signature recovery, hashing, transaction or EIP-712 encoding
- A GPU that runs unbilled, or is billed after it ended
- Another wallet's outputs or files being readable
- A receipt whose proof does not reach the sealed root
- A request that takes the server down

## Versions

Fixes land on `main` and the newest tag.
