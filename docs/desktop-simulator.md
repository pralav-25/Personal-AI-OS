# Synthetic Mac desktop fixture

The `--desktop` option starts a synthetic desktop host for the simulator. Its file tools are confined to one scratch directory; it cannot access product folders or control native Mac apps. For Gateway setup and pairing, start with [the first-run guide](first-run.md). This page covers only the optional desktop fixture.

## Prerequisites and scope

- Use a development or test Gateway, a Mac pairing JSON file and its matching recipient private JWK. Keep those credentials out of source control.
- Run with Node 24.18 or newer, below 25, and the Gateway dependencies installed. See [the testing guide](testing.md) for checkout-local setup.
- Create a dedicated scratch directory. It must exist, and it cannot be `/` or your home directory. Use synthetic files only.

The simulator connects to the origin in the pairing file unless `--origin` is provided. `--prompt` sends text through that Gateway, so use a local or test instance and synthetic text; do not point it at production.

## Start a text-only session

Run from the repository root. Replace the two file paths with test-only Mac pairing credentials:

```sh
scratch="$(mktemp -d "${TMPDIR:-/tmp}/paios-desktop-sim.XXXXXX")"
chmod 700 "$scratch"

node 01-product-half-finished/backend/phase0/gateway/tools/mac-product-sim-client.ts \
  --pairing /path/to/mac-pairing.v1.json \
  --recipient-key /path/to/recipient.jwk \
  --desktop "$scratch" \
  --desktop-seconds 300 \
  --text-only \
  --prompt 'Synthetic desktop fixture check'
```

`--pairing` and `--recipient-key` are required; the pairing must identify a Mac and match the private JWK. The desktop host runs for 300 seconds by default. `--desktop-seconds` accepts values from 1 through 3600.

To test an attachment, first put a synthetic file inside `$scratch`, then add `--desktop-attachment "$scratch/sample.txt"`. The optional `--desktop-via drag|paste` selects the simulated grant method (`drag` by default); `--desktop-revoke-after SECONDS` can expire the grant after acceptance.

PDF text extraction requires `pdftotext` on the simulator process's `PATH`. Image and Word extraction are unsupported by this synthetic host.

## Clean up

When the process exits, it closes the simulated host but leaves the scratch directory and its contents in place. Depending on the tools used, it may contain `.fixture-grant.json`, `.incoming`, `.undo` or `.trash`. In the same shell session that set `scratch`, retain anything needed, then remove only the dedicated temporary directory created above:

```sh
rm -r "$scratch"
```
