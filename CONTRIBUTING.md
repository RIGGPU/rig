# Contributing to RIG

RIG is one Node.js program with no dependencies and a browser client with no build step. That is a feature; please keep it.

## Setup

```bash
git clone https://github.com/RIGGPU/rig
cd rig
RIG_TEST=1 TREASURY=0x000000000000000000000000000000000000beef npm start
npm test
```

## Ground rules

- Money is integers. Micro-credits and atomic token units, never floats.
- Credit only what the chain has confirmed.
- Bill only seconds a GPU ran.
- Chain code lives in `server/evm.js` and nowhere else. Provider code lives in `server/provider.js` and nowhere else.
- A change to credits, billing, keys, signatures or x402 comes with a check in `test/run.js` that fails without it.

## Sending a change

Branch from `dev`, keep it small, run `npm test`, and open a pull request against `dev` that says what you ran.

Security problems go through [private reporting](https://github.com/RIGGPU/rig/security/advisories/new).
