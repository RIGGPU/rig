# RIG

[![license](https://img.shields.io/badge/license-MIT-00c805)](LICENSE) [![node](https://img.shields.io/badge/node-%E2%89%A5%2022-00c805)](.node-version) [![dependencies](https://img.shields.io/badge/dependencies-0-00c805)](package.json) [![checks](https://img.shields.io/badge/end--to--end%20checks-78-00c805)](test)

**[riggpu.run](https://riggpu.run)** · [App](https://riggpu.run/app) · [Docs](https://riggpu.run/docs) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)

Rent the rig. RIG is a GPU cloud that settles on Robinhood Chain: a whole NVIDIA GPU billed by the second, or a single image, video or voice billed by the piece. People pay with USDG, ETH or $RIG. Agents pay with an API key or with x402.

## Run it

```bash
git clone https://github.com/RIGGPU/rig
cd rig
RIG_TEST=1 TREASURY=0x000000000000000000000000000000000000beef npm start   # http://localhost:8322
npm test                                                                    # 83 end-to-end checks
```

Needs Node 22 or newer and nothing else. `RIG_TEST=1` stands in for the GPU provider and the chain, so every flow works locally with no key and no funds.

## What is in the box

| | |
|---|---|
| **Credits** | 1 credit = $1 of compute at listed prices, sold for 0.70 USDG. Deposits are read back from the chain before they count. Unused credits refund at the price paid, in the asset paid with. |
| **Rentals** | SSH and Jupyter on a whole GPU. The meter starts when SSH is ready and stops when you end it. `rig/auto` picks the cheapest open card with enough memory. A card that never starts is never billed. |
| **Outputs** | 13 image, video and voice models with a price per output. Credits come back if an output fails. |
| **Keys** | Up to 10 API keys per wallet, each with an optional daily spend cap and a stop switch only the wallet can flip. |
| **MCP** | 14 tools at `/mcp` over Streamable HTTP. |
| **x402** | A request with no key answers 402 with a USDG price. The agent signs an EIP-3009 transfer, RIG checks the signature itself, submits it and pays the gas. |
| **Receipts** | One per rental and output, hashed hourly into a Merkle root that is written into the data of a transaction. |
| **$RIG** | 1,000 held makes 50 images and 2 videos free per day. Credits bought with it are spent first and the tokens behind them go to the dead address each hour. |

## Source map

```
server/evm.js       keccak-256, secp256k1 (recover + RFC 6979 signing), RLP, EIP-1559, EIP-3009, RPC, payment reads
server/engine.js    the ledger: lots of credits, meters, keys, receipts, refunds, the burn
server/provider.js  the GPU and model provider, plus the local stand-in
server/index.js     routes, the x402 flow, the MCP tools
client/             landing page, app and docs, no build step
test/run.js         the end-to-end suite
```

Nothing is imported from npm. The chain code is written out in `server/evm.js` and checked in the test suite against published values.

## Calling it

```bash
# with a key
curl https://riggpu.run/api/v1/outputs \
  -H "Authorization: Bearer $RIG_KEY" -H "Content-Type: application/json" \
  -d '{"model": "flux-schnell", "prompt": "A lighthouse at dusk"}'

# rent the cheapest GPU with 48 GB
curl https://riggpu.run/api/v1/instances \
  -H "Authorization: Bearer $RIG_KEY" -H "Content-Type: application/json" \
  -d '{"gpu": "auto", "vram": 48}'

# an agent over MCP
claude mcp add --transport http rig https://riggpu.run/mcp --header "Authorization: Bearer $RIG_KEY"
```

Without the Authorization header, `POST /api/v1/outputs` answers 402 and the `PAYMENT-REQUIRED` header carries what to sign: network `eip155:4663`, asset USDG, EIP-712 domain `Global Dollar` version `1`.

## Checking a receipt

`leaf = sha256(id|wallet|kind|ref|what|micro|seconds|ts)`. Fold the proof in, smaller hash first at each step, and you reach the root of that hour. The root is in the transaction data as `rig:receipts:v1:HOUR:ROOT`. `GET /api/receipts/{id}/proof` returns the path, and the app does the check in the browser.

## Settings

| Variable | Purpose |
|---|---|
| `TREASURY` | Address that receives deposits and x402 payments |
| `TREASURY_SECRET` | 32-byte hex key for that address. Required for x402. Also sends refunds, the hourly root and the burn. Keep a little ETH on it for gas |
| `RUNPOD_API_KEY` | Connects the GPUs and model endpoints |
| `TOKEN_ADDRESS` | Contract of $RIG. Turns on paying with it, free outputs and the burn |
| `RPC_URL` | Robinhood Chain RPC, comma-separated if several |
| `DATA_PATH` | The ledger file. Put it on a persistent disk |
| `MARKUP` | Listed rate over provider cost. Default 1.5, floor 1.43 |
| `POD_IMAGE` | Container image a rented GPU boots |
| `SITE_URL`, `X_URL`, `GH_URL` | Public origin and links |
| `ADMIN_KEY` | Opens `/api/admin/*` |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities [privately](https://github.com/RIGGPU/rig/security/advisories/new), never in a public issue.

## License

[MIT](LICENSE)
